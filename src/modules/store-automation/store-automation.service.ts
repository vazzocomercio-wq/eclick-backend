import { Injectable, Logger, BadRequestException, NotFoundException, Inject, forwardRef } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StoreAutomationEngine } from './store-automation.engine'
import { StoreAutomationExecutor } from './store-automation.executor'
import type {
  StoreAutomationAction,
  StoreAutomationConfig,
  AutomationStatus,
  AutomationTrigger,
  AutomationSeverity,
} from './store-automation.types'

@Injectable()
export class StoreAutomationService {
  private readonly logger = new Logger(StoreAutomationService.name)

  constructor(
    private readonly engine: StoreAutomationEngine,
    @Inject(forwardRef(() => StoreAutomationExecutor))
    private readonly executor: StoreAutomationExecutor,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────────────────────────────────

  async getConfig(orgId: string): Promise<StoreAutomationConfig> {
    const { data, error } = await supabaseAdmin
      .from('store_automation_config')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (data) return data as StoreAutomationConfig

    const { data: created, error: insErr } = await supabaseAdmin
      .from('store_automation_config')
      .insert({ organization_id: orgId })
      .select('*')
      .maybeSingle()
    if (insErr || !created) throw new BadRequestException(`Erro ao criar config: ${insErr?.message}`)
    return created as StoreAutomationConfig
  }

  async updateConfig(orgId: string, patch: Partial<StoreAutomationConfig>): Promise<StoreAutomationConfig> {
    await this.getConfig(orgId)
    const allowed: (keyof StoreAutomationConfig)[] = [
      'enabled', 'analysis_frequency',
      'active_triggers', 'auto_execute_triggers',
      'notify_channel', 'notify_min_severity',
      'max_auto_actions_per_day', 'max_price_change_auto_pct', 'max_budget_auto_brl',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) {
      if (k in patch) safe[k] = patch[k]
    }
    if (Object.keys(safe).length === 0) {
      throw new BadRequestException('nada pra atualizar')
    }
    const { data, error } = await supabaseAdmin
      .from('store_automation_config')
      .update(safe)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as StoreAutomationConfig
  }

  // ─────────────────────────────────────────────────────────────────
  // ANALYZE — roda detecção e persiste novas actions
  // ─────────────────────────────────────────────────────────────────

  async analyze(orgId: string): Promise<{ created: number; deduped: number }> {
    const config = await this.getConfig(orgId)
    if (!config.enabled) {
      throw new BadRequestException('Automações desabilitadas pra esta org')
    }

    const detected = await this.engine.detect(orgId, config.active_triggers)
    if (detected.length === 0) {
      await this.markAnalyzed(orgId)
      return { created: 0, deduped: 0 }
    }

    // Dedup contra ações pending recentes (evita poluir inbox quando o
    // detector encontra a mesma situação dia após dia)
    let deduped = 0
    let created = 0
    for (const d of detected) {
      const dupe = await this.findRecentDuplicate(orgId, d.trigger_type, d.product_ids)
      if (dupe) { deduped++; continue }

      await supabaseAdmin
        .from('store_automation_actions')
        .insert({
          organization_id:  orgId,
          trigger_type:     d.trigger_type,
          title:            d.title,
          description:      d.description,
          severity:         d.severity,
          product_ids:      d.product_ids,
          affected_count:   d.affected_count,
          proposed_action:  d.proposed_action,
        })
      created++
    }

    await this.markAnalyzed(orgId)
    return { created, deduped }
  }

  /** Detecta duplicate: trigger_type + mesmos product_ids dentro de 48h
   *  com status pending|approved|executing. */
  private async findRecentDuplicate(
    orgId: string,
    trigger: AutomationTrigger,
    productIds: string[],
  ): Promise<boolean> {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from('store_automation_actions')
      .select('product_ids')
      .eq('organization_id', orgId)
      .eq('trigger_type', trigger)
      .in('status', ['pending', 'approved', 'executing'])
      .gte('created_at', since)
      .limit(20)

    if (!data?.length) return false
    if (productIds.length === 0) return data.length > 0  // ações sem produto: 1 vigente é o suficiente

    const idSet = new Set(productIds)
    for (const row of data) {
      const rowIds = (row as { product_ids: string[] }).product_ids ?? []
      const overlap = rowIds.some(id => idSet.has(id))
      if (overlap) return true
    }
    return false
  }

  private async markAnalyzed(orgId: string): Promise<void> {
    await supabaseAdmin
      .from('store_automation_config')
      .update({ last_analysis_at: new Date().toISOString() })
      .eq('organization_id', orgId)
  }

  // ─────────────────────────────────────────────────────────────────
  // ACTIONS LIFECYCLE
  // ─────────────────────────────────────────────────────────────────

  async listActions(orgId: string, opts: {
    status?:       AutomationStatus
    trigger_type?: AutomationTrigger
    severity?:     AutomationSeverity
    limit?:        number
    offset?:       number
  } = {}): Promise<{ items: StoreAutomationAction[]; total: number }> {
    const limit  = Math.min(opts.limit  ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('store_automation_actions')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('severity_rank', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    // severity_rank não existe; usa simples order created_at
    q = supabaseAdmin
      .from('store_automation_actions')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (opts.status)        q = q.eq('status',       opts.status)
    if (opts.trigger_type)  q = q.eq('trigger_type', opts.trigger_type)
    if (opts.severity)      q = q.eq('severity',     opts.severity)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { items: (data ?? []) as StoreAutomationAction[], total: count ?? 0 }
  }

  async getAction(id: string, orgId: string): Promise<StoreAutomationAction> {
    const { data, error } = await supabaseAdmin
      .from('store_automation_actions')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Ação não encontrada')
    return data as StoreAutomationAction
  }

  /** Aprovar = marca como approved → executor dispara → completed/failed. */
  async approve(id: string, orgId: string): Promise<StoreAutomationAction> {
    const approved = await this.transition(id, orgId, 'approved', ['pending'])
    // Dispara executor em background (caller não fica esperando)
    void this.executor.execute(approved).catch(e =>
      this.logger.warn(`[approve] executor ${id} falhou: ${(e as Error).message}`),
    )
    return approved
  }

  async reject(id: string, orgId: string, feedback?: 'util'|'nao_relevante'|'timing_ruim'|'acao_errada'): Promise<StoreAutomationAction> {
    const action = await this.getAction(id, orgId)
    if (action.status !== 'pending') {
      throw new BadRequestException(`Não pode rejeitar em status '${action.status}'`)
    }
    const { data, error } = await supabaseAdmin
      .from('store_automation_actions')
      .update({
        status:           'rejected',
        lojista_feedback: feedback ?? 'nao_relevante',
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as StoreAutomationAction
  }

  async approveBatch(orgId: string, ids: string[]): Promise<{ approved: number; failed: number }> {
    let approved = 0, failed = 0
    for (const id of ids) {
      try { await this.approve(id, orgId); approved++ }
      catch { failed++ }
    }
    return { approved, failed }
  }

  async setFeedback(id: string, orgId: string, feedback: 'util'|'nao_relevante'|'timing_ruim'|'acao_errada'): Promise<StoreAutomationAction> {
    const { data, error } = await supabaseAdmin
      .from('store_automation_actions')
      .update({ lojista_feedback: feedback })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as StoreAutomationAction
  }

  async stats(orgId: string): Promise<{
    pending:     number
    approved:    number
    executed:    number
    rejected:    number
    by_trigger:  Record<AutomationTrigger, number>
  }> {
    const { data, error } = await supabaseAdmin
      .from('store_automation_actions')
      .select('status, trigger_type')
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    const byTrigger: Record<string, number> = {}
    let pending = 0, approved = 0, executed = 0, rejected = 0
    for (const r of (data ?? [])) {
      const row = r as { status: AutomationStatus; trigger_type: AutomationTrigger }
      byTrigger[row.trigger_type] = (byTrigger[row.trigger_type] ?? 0) + 1
      if (row.status === 'pending')                                pending++
      else if (row.status === 'approved')                          approved++
      else if (row.status === 'completed' || row.status === 'auto_executed') executed++
      else if (row.status === 'rejected')                          rejected++
    }
    return { pending, approved, executed, rejected, by_trigger: byTrigger as Record<AutomationTrigger, number> }
  }

  // Pra worker
  async listOrgsForAnalysis(): Promise<Array<{ organization_id: string; analysis_frequency: string }>> {
    const { data, error } = await supabaseAdmin
      .from('store_automation_config')
      .select('organization_id, analysis_frequency, last_analysis_at, enabled')
      .eq('enabled', true)
      .limit(20)
    if (error) {
      this.logger.warn(`[store-automation] listOrgsForAnalysis: ${error.message}`)
      return []
    }
    return (data ?? []) as Array<{ organization_id: string; analysis_frequency: string }>
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────

  private async transition(
    id: string,
    orgId: string,
    to: AutomationStatus,
    fromAllowed: AutomationStatus[],
  ): Promise<StoreAutomationAction> {
    const { data, error } = await supabaseAdmin
      .from('store_automation_actions')
      .update({ status: to })
      .eq('id', id)
      .eq('organization_id', orgId)
      .in('status', fromAllowed)
      .select('*')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new BadRequestException(`Transição inválida: '${to}' só de [${fromAllowed.join(',')}]`)
    return data as StoreAutomationAction
  }
}
