import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'

/**
 * LearningService — cron diário (03h) que:
 *   1. Calcula action_rate por (manager, signal_category) na janela de
 *      `learning_decay_days` (default 30) e salva em manager.preferences.
 *   2. Limpa signals expirados (expires_at < now) marcando status='expired'.
 *
 * action_rate = deliveries com response_type='approve' / total respondidas.
 * Categorias com sample < 5 são ignoradas (ruído).
 *
 * O AlertEngine pode opcionalmente consultar manager.preferences[cat]
 * pra ajustar roteamento, mas isso fica como hook futuro — por ora o
 * Learning só observa, sem alterar comportamento do engine.
 */
@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name)
  private isRunning = false

  @Cron('0 3 * * *', { name: 'alertHubLearningTick' })
  async tick(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      await this.expireOldSignals()
      await this.updateAllManagersStats()
    } catch (e) {
      this.logger.error(`[tick] erro inesperado: ${(e as Error).message}`)
    } finally {
      this.isRunning = false
    }
  }

  /**
   * Marca signals com expires_at < now e status novo/dispatched/delivered como 'expired'.
   */
  private async expireOldSignals(): Promise<void> {
    const now = new Date().toISOString()
    const { error, count } = await supabaseAdmin
      .from('alert_signals')
      .update({ status: 'expired' }, { count: 'exact' })
      .lt('expires_at', now)
      .in('status', ['new', 'dispatched', 'delivered'])
    if (error) {
      this.logger.error(`[expire] falhou: ${error.message}`)
      return
    }
    if ((count ?? 0) > 0) {
      this.logger.log(`[expire] ${count} signals expirados`)
    }
  }

  private async updateAllManagersStats(): Promise<void> {
    // 1. Carrega config da org pra learning_decay_days
    const { data: configs } = await supabaseAdmin
      .from('alert_hub_config')
      .select('organization_id, enabled, learning_enabled, learning_decay_days')
      .eq('enabled', true)
      .eq('learning_enabled', true)
    if (!configs || configs.length === 0) return

    let totalUpdated = 0
    for (const cfg of configs) {
      const days = cfg.learning_decay_days ?? 30
      const updated = await this.processOrg(cfg.organization_id, days)
      totalUpdated += updated
    }

    if (totalUpdated > 0) {
      this.logger.log(`[learning] managers atualizados=${totalUpdated}`)
    }
  }

  /**
   * Pra cada manager da org com pelo menos 1 delivery respondida na janela:
   * recalcula action_rate por categoria e atualiza preferences.
   */
  private async processOrg(orgId: string, decayDays: number): Promise<number> {
    const since = new Date(Date.now() - decayDays * 86_400_000).toISOString()

    // Pega deliveries respondidas com signal join pra category
    const { data: rows, error } = await supabaseAdmin
      .from('alert_deliveries')
      .select(`
        manager_id, response_type,
        alert_signals!inner ( category )
      `)
      .eq('organization_id', orgId)
      .not('response_at', 'is', null)
      .gte('created_at', since)
    if (error) {
      this.logger.error(`[org ${orgId}] deliveries query: ${error.message}`)
      return 0
    }

    if ((rows ?? []).length === 0) return 0

    // Agrega por manager + category
    interface Bucket { approve: number; ignore: number; total: number }
    const map = new Map<string, Map<string, Bucket>>()  // manager → category → bucket

    type Row = {
      manager_id: string
      response_type: string | null
      alert_signals: { category: string } | { category: string }[] | null
    }
    for (const r of (rows ?? []) as unknown as Row[]) {
      const managerId    = r.manager_id
      const responseType = r.response_type
      const sigField     = r.alert_signals
      const category     = Array.isArray(sigField) ? sigField[0]?.category : sigField?.category
      if (!category) continue

      const byCat = map.get(managerId) ?? new Map<string, Bucket>()
      const b = byCat.get(category) ?? { approve: 0, ignore: 0, total: 0 }
      b.total++
      if (responseType === 'approve')      b.approve++
      else if (responseType === 'ignore')  b.ignore++
      byCat.set(category, b)
      map.set(managerId, byCat)
    }

    let updated = 0
    for (const [managerId, byCat] of map) {
      // Carrega preferences atual do manager
      const { data: cur } = await supabaseAdmin
        .from('alert_managers')
        .select('preferences')
        .eq('id', managerId)
        .maybeSingle()
      const prefs = (cur?.preferences ?? {}) as Record<string, unknown>

      const learnedAt = new Date().toISOString()
      const learning: Record<string, { action_rate: number; sample_size: number; ignore_rate: number }> = {}

      for (const [cat, b] of byCat) {
        if (b.total < 5) continue   // ruído
        learning[cat] = {
          action_rate:  b.approve / b.total,
          ignore_rate:  b.ignore  / b.total,
          sample_size:  b.total,
        }
      }

      const updatedPrefs = {
        ...prefs,
        learning,
        learned_at: learnedAt,
      }

      const { error: upErr } = await supabaseAdmin
        .from('alert_managers')
        .update({ preferences: updatedPrefs })
        .eq('id', managerId)

      if (upErr) {
        this.logger.error(`[learning] manager=${managerId}: ${upErr.message}`)
      } else {
        updated++
      }
    }

    return updated
  }
}
