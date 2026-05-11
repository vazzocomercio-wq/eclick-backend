import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Scanner de automação de preço (`/pricing-automation/*`).
 *
 * Fluxo híbrido — evita iterar 1000+ items ativos do seller:
 *  1. GET /pricing-automation/users/{seller}/items → IDs automatizados (1 call)
 *  2. Pra cada item AUTOMATIZADO: GET /automation → status, item_rule, min/max,
 *     status_detail{cause, message}. (Pacing 200ms.)
 *  3. Pra items COM SUGESTÃO de preço (em cache ml_listing_pricing_suggestions
 *     do Sprint 3): GET /rules pra ver se elegíveis. Candidatos óbvios.
 *
 * Cria tasks `PRICE_AUTOMATION_AVAILABLE` quando recomendação != no_action.
 *
 * IMPORTANTE: itens com automation_status='ACTIVE' têm blocks_manual_edit=true.
 * A partir de 18/03/2026 ML rejeita PUT /items/{id} com price nesses.
 */
@Injectable()
export class ListingAutomationScannerService {
  private readonly logger = new Logger(ListingAutomationScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned: number
    automated_count: number
    eligible_count: number
    tasks_created: number
    tasks_updated: number
    tasks_resolved_auto: number
    api_calls: number
  }> {
    const t0 = Date.now()
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Step 1: lista de items automatizados
    let automatedIds: string[] = []
    try {
      const { data } = await axios.get(
        `${ML_BASE}/pricing-automation/users/${sellerId}/items`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
      )
      automatedIds = (data?.items ?? []) as string[]
    } catch (err) {
      this.logger.warn(`[automation-scanner] step1 falhou: ${(err as Error).message}`)
    }
    const automatedSet = new Set(automatedIds)
    let apiCalls = 1

    // Step 2: items que estão no cache de sugestões (Sprint 3) — candidatos
    // óbvios pra avaliar automação. Vazzo tem 140 itens em cache.
    const { data: cachedSuggestions } = await supabaseAdmin
      .from('ml_listing_pricing_suggestions')
      .select('ml_item_id, product_id')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .limit(500)
    const candidateIds = new Set<string>((cachedSuggestions ?? []).map(r => (r as { ml_item_id: string }).ml_item_id))
    // Garante que todos os automatizados sejam scaneados (independente do cache)
    automatedIds.forEach(id => candidateIds.add(id))

    let created = 0
    let updated = 0
    let eligibleCount = 0

    for (const itemId of candidateIds) {
      const isAutomated = automatedSet.has(itemId)

      // Rules disponíveis (sempre)
      let rules: Array<{ rule_id: string }> = []
      try {
        const { data } = await axios.get(
          `${ML_BASE}/pricing-automation/items/${itemId}/rules`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
        )
        rules = (data?.rules ?? []) as Array<{ rule_id: string }>
        apiCalls++
      } catch (err) {
        const status = (err as { response?: { status?: number } }).response?.status
        if (status !== 404) {
          this.logger.warn(`[automation-scanner] rules ${itemId}: ${(err as Error).message}`)
        }
      }

      // Automation status (só se já está automatizado)
      let automation: {
        status?: string
        item_rule?: { rule_id?: string }
        min_price?: number
        max_price?: number
        status_detail?: { cause?: string; message?: string }
      } | null = null

      if (isAutomated) {
        try {
          const { data } = await axios.get(
            `${ML_BASE}/pricing-automation/items/${itemId}/automation`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
          )
          automation = data
          apiCalls++
        } catch (err) {
          this.logger.warn(`[automation-scanner] automation ${itemId}: ${(err as Error).message}`)
        }
      }

      const recommendation = this.determineRecommendation(rules, automation)
      const product = await this.findProductId(orgId, itemId)

      // Upsert no cache
      const blocksManualEdit = isAutomated && automation?.status === 'ACTIVE'
      await supabaseAdmin.from('ml_listing_pricing_automation').upsert({
        organization_id: orgId,
        seller_id: sellerId,
        ml_item_id: itemId,
        product_id: product,
        available_rules: rules,
        is_automated: isAutomated,
        active_rule: automation?.item_rule?.rule_id ?? null,
        automation_status: automation?.status ?? null,
        pause_cause: automation?.status_detail?.cause ?? null,
        pause_message: automation?.status_detail?.message ?? null,
        min_price: automation?.min_price ?? null,
        max_price: automation?.max_price ?? null,
        internal_recommendation: recommendation.action,
        recommendation_reason: recommendation.reason,
        blocks_manual_edit: blocksManualEdit,
        raw_rules_response: rules,
        raw_automation_response: automation,
        fetched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'organization_id,seller_id,ml_item_id',
      })

      // Cria tarefa se recomendação relevante
      if (recommendation.action !== 'no_action') {
        const result = await this.upsertAutomationTask(orgId, sellerId, itemId, product, recommendation, automation, rules)
        if (result === 'created') created++
        else if (result === 'updated') updated++
      }

      if (rules.length > 0 && !isAutomated) eligibleCount++

      await new Promise(res => setTimeout(res, 200))
    }

    const resolvedAuto = await this.autoResolveStale(orgId, sellerId)

    this.logger.log(
      `[automation-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `candidates=${candidateIds.size} automated=${automatedIds.length} ` +
      `eligible=${eligibleCount} created=${created} updated=${updated} ` +
      `resolved=${resolvedAuto} em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned: candidateIds.size,
      automated_count: automatedIds.length,
      eligible_count: eligibleCount,
      tasks_created: created,
      tasks_updated: updated,
      tasks_resolved_auto: resolvedAuto,
      api_calls: apiCalls,
    }
  }

  private async findProductId(orgId: string, itemId: string): Promise<string | null> {
    const { data: pl } = await supabaseAdmin
      .from('product_listings')
      .select('product_id')
      .eq('listing_id', itemId)
      .eq('platform', 'mercadolivre')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    return (pl as { product_id?: string | null } | null)?.product_id ?? null
  }

  private determineRecommendation(
    rules: Array<{ rule_id: string }>,
    automation: { status?: string; min_price?: number; max_price?: number; status_detail?: { cause?: string } } | null,
  ): { action: 'activate' | 'configure_limits' | 'review_pause' | 'unpause' | 'no_action' | 'consider_disable'; reason: string } {
    // Não tem rules disponíveis nem automação → no_action
    if (rules.length === 0 && !automation) {
      return { action: 'no_action', reason: 'Sem regras disponíveis pra esse item' }
    }

    // Tem rules mas não usa
    if (rules.length > 0 && !automation) {
      return {
        action: 'activate',
        reason: `Pode ativar automação (${rules.map(r => r.rule_id).join('/')}) — item nas sugestões de preço`,
      }
    }

    // Está pausada
    if (automation?.status === 'PAUSED') {
      const cause = automation.status_detail?.cause
      if (cause === 'PROMO') {
        return { action: 'no_action', reason: 'Pausada por promoção em vigor — normal' }
      }
      return {
        action: 'review_pause',
        reason: `Automação pausada (motivo: ${cause ?? 'desconhecido'}) — verificar`,
      }
    }

    // Ativa mas sem limites
    if (automation?.status === 'ACTIVE' && (!automation.min_price || !automation.max_price)) {
      return {
        action: 'configure_limits',
        reason: 'Automação ativa SEM min/max — risco de margem',
      }
    }

    return { action: 'no_action', reason: 'Configuração ok' }
  }

  private async upsertAutomationTask(
    orgId: string,
    sellerId: number,
    itemId: string,
    productId: string | null,
    rec: { action: string; reason: string },
    automation: { status?: string } | null,
    rules: Array<{ rule_id: string }>,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const severity =
      rec.action === 'configure_limits' ? 'high' :
      rec.action === 'review_pause'     ? 'medium' :
      rec.action === 'activate'         ? 'low' :
      'low'
    const priority =
      rec.action === 'configure_limits' ? 75 :
      rec.action === 'review_pause'     ? 60 :
      rec.action === 'activate'         ? 45 :
      30

    const title =
      rec.action === 'activate'         ? 'Pode ativar automação de preço' :
      rec.action === 'configure_limits' ? 'Automação sem limites min/max' :
      rec.action === 'review_pause'     ? 'Automação pausada — revisar' :
      'Automação de preço'

    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', itemId)
      .eq('task_type', 'PRICE_AUTOMATION_AVAILABLE')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at: new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          severity,
          priority_score: priority,
          task_title: title,
          task_description: rec.reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id: orgId,
      seller_id: sellerId,
      ml_item_id: itemId,
      product_id: productId,
      task_type: 'PRICE_AUTOMATION_AVAILABLE',
      task_title: title,
      task_description: rec.reason,
      source: 'scanner_automation',
      severity,
      priority_score: priority,
      impact_area: ['sales', 'exposure'],
      current_value: { automation_status: automation?.status, rules: rules.map(r => r.rule_id) },
      suggested_action:
        rec.action === 'activate'         ? `Ativar regra ${rules[0]?.rule_id ?? 'INT'} no Pricing IA` :
        rec.action === 'configure_limits' ? 'Configurar min/max no Pricing IA' :
        rec.action === 'review_pause'     ? 'Verificar motivo do pause e despausar se cabível' :
        rec.reason,
      deeplink_url: `https://eclick.app.br/dashboard/listings/pricing/automation`,
      deeplink_module: 'listing_center',
      status: 'open',
    })
    if (error) {
      this.logger.warn(`[automation-scanner] insert ${itemId}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  private async autoResolveStale(orgId: string, sellerId: number): Promise<number> {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_auto',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Automação ajustada (sinal não detectado mais)',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('source', 'scanner_automation')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')
    if (error) {
      this.logger.warn(`[automation-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  // ── Endpoints helpers (chamados pelo controller) ─────────────────────────

  async listAutomation(orgId: string, opts: {
    seller_id?: number
    filter?: 'all' | 'eligible' | 'active' | 'paused'
    limit?: number
  } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    let q = supabaseAdmin
      .from('ml_listing_pricing_automation')
      .select('*')
      .eq('organization_id', orgId)
    if (opts.seller_id != null) q = q.eq('seller_id', opts.seller_id)

    if (opts.filter === 'eligible') {
      q = q.eq('is_automated', false).eq('internal_recommendation', 'activate')
    } else if (opts.filter === 'active') {
      q = q.eq('automation_status', 'ACTIVE')
    } else if (opts.filter === 'paused') {
      q = q.eq('automation_status', 'PAUSED')
    }

    q = q.order('updated_at', { ascending: false }).limit(limit)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** POST pra ativar automação no ML. Usa rule_id = INT por default. */
  async activateAutomation(orgId: string, sellerId: number, itemId: string, ruleId: 'INT' | 'INT_EXT' = 'INT', limits?: { min_price?: number; max_price?: number }): Promise<{ success: boolean; status?: string }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    try {
      const body: Record<string, unknown> = { item_rule: { rule_id: ruleId } }
      if (limits?.min_price != null) body.min_price = limits.min_price
      if (limits?.max_price != null) body.max_price = limits.max_price

      await axios.post(
        `${ML_BASE}/pricing-automation/items/${itemId}/automation`,
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      )
      await this.markCacheAutomated(orgId, sellerId, itemId, ruleId, 'ACTIVE', limits)
      return { success: true, status: 'ACTIVE' }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string }).response?.data?.message
        ?? (err as Error).message
      throw new Error(`POST automation ${itemId}: ${msg}`)
    }
  }

  async pauseAutomation(orgId: string, sellerId: number, itemId: string): Promise<{ success: boolean }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    try {
      await axios.put(
        `${ML_BASE}/pricing-automation/items/${itemId}/automation`,
        { status: 'PAUSED' },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      )
      await supabaseAdmin.from('ml_listing_pricing_automation')
        .update({ automation_status: 'PAUSED', updated_at: new Date().toISOString() })
        .eq('organization_id', orgId).eq('seller_id', sellerId).eq('ml_item_id', itemId)
      return { success: true }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string }).response?.data?.message
        ?? (err as Error).message
      throw new Error(`PUT pause ${itemId}: ${msg}`)
    }
  }

  async configureLimits(orgId: string, sellerId: number, itemId: string, min: number, max: number): Promise<{ success: boolean }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    try {
      await axios.put(
        `${ML_BASE}/pricing-automation/items/${itemId}/automation`,
        { min_price: min, max_price: max },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      )
      await supabaseAdmin.from('ml_listing_pricing_automation')
        .update({ min_price: min, max_price: max, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId).eq('seller_id', sellerId).eq('ml_item_id', itemId)
      return { success: true }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string }).response?.data?.message
        ?? (err as Error).message
      throw new Error(`PUT limits ${itemId}: ${msg}`)
    }
  }

  async disableAutomation(orgId: string, sellerId: number, itemId: string): Promise<{ success: boolean }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    try {
      await axios.delete(
        `${ML_BASE}/pricing-automation/items/${itemId}/automation`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
      )
      await supabaseAdmin.from('ml_listing_pricing_automation')
        .update({
          is_automated: false,
          automation_status: null,
          active_rule: null,
          min_price: null,
          max_price: null,
          blocks_manual_edit: false,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', orgId).eq('seller_id', sellerId).eq('ml_item_id', itemId)
      return { success: true }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string }).response?.data?.message
        ?? (err as Error).message
      throw new Error(`DELETE automation ${itemId}: ${msg}`)
    }
  }

  private async markCacheAutomated(
    orgId: string,
    sellerId: number,
    itemId: string,
    ruleId: string,
    status: 'ACTIVE' | 'PAUSED',
    limits?: { min_price?: number; max_price?: number },
  ): Promise<void> {
    await supabaseAdmin.from('ml_listing_pricing_automation')
      .update({
        is_automated: true,
        active_rule: ruleId,
        automation_status: status,
        min_price: limits?.min_price ?? null,
        max_price: limits?.max_price ?? null,
        blocks_manual_edit: status === 'ACTIVE',
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId).eq('seller_id', sellerId).eq('ml_item_id', itemId)
  }
}
