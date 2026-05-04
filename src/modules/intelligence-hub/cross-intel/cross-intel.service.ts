import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { AlertSignalsService } from '../alert-signals.service'
import { AlertHubConfigService } from '../alert-hub-config.service'
import { AlertEngineService } from '../alert-engine.service'
import { CROSS_INTEL_PATTERNS } from './patterns'
import type { AlertSignal, SignalDraft } from '../analyzers/analyzers.types'

const LOOKBACK_HOURS = 24
const SIGNAL_TTL_HOURS = 24

/**
 * CrossIntelService — analisa signals existentes e gera signals derivados
 * (analyzer='cross_intel') quando 2+ signals da mesma entity batem com
 * algum padrão pré-definido em patterns.ts.
 *
 * Roda como cron a cada 30min — depois dos analyzers (que rodam a cada
 * 15 min) terem gerado a maioria dos signals do ciclo.
 *
 * Pula execução se config.cross_intel_enabled = false.
 */
@Injectable()
export class CrossIntelService {
  private readonly logger = new Logger(CrossIntelService.name)
  private isRunning = false

  constructor(
    private readonly signalsSvc: AlertSignalsService,
    private readonly hubCfg:     AlertHubConfigService,
    private readonly engine:     AlertEngineService,
  ) {}

  @Cron('*/30 * * * *', { name: 'alertHubCrossIntelTick' })
  async tick(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      await this.processAllOrgs()
    } catch (e) {
      this.logger.error(`[tick] erro inesperado: ${(e as Error).message}`)
    } finally {
      this.isRunning = false
    }
  }

  private async processAllOrgs(): Promise<void> {
    const { data: configs, error } = await supabaseAdmin
      .from('alert_hub_config')
      .select('organization_id, enabled, cross_intel_enabled')
      .eq('enabled', true)
      .eq('cross_intel_enabled', true)
    if (error) {
      this.logger.error(`[processAll] config query: ${error.message}`)
      return
    }
    if ((configs ?? []).length === 0) return

    let totalInsights = 0
    for (const cfg of configs ?? []) {
      const created = await this.processOrg(cfg.organization_id)
      totalInsights += created
    }
    if (totalInsights > 0) {
      this.logger.log(`[tick] orgs=${configs?.length ?? 0} cross_insights=${totalInsights}`)
    }
  }

  async processOrg(orgId: string): Promise<number> {
    // Pega signals recentes (24h), excluindo já cross-intel
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .select('*')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .neq('analyzer', 'cross_intel')
      .not('entity_id', 'is', null)
    if (error) {
      this.logger.error(`[org ${orgId}] signals query: ${error.message}`)
      return 0
    }

    const signals = (data ?? []) as AlertSignal[]
    if (signals.length < 2) return 0

    // Agrupa por entity_id
    const byEntity = new Map<string, AlertSignal[]>()
    for (const s of signals) {
      if (!s.entity_id) continue
      const arr = byEntity.get(s.entity_id) ?? []
      arr.push(s)
      byEntity.set(s.entity_id, arr)
    }

    const drafts: SignalDraft[] = []
    const allSourceIds: string[][] = []
    const expiresAt = new Date(Date.now() + SIGNAL_TTL_HOURS * 3_600_000).toISOString()

    for (const [entityId, entitySignals] of byEntity) {
      if (entitySignals.length < 2) continue
      // Aplica todos padrões; um match por padrão por entity (evita duplicar)
      for (const pattern of CROSS_INTEL_PATTERNS) {
        const insight = pattern.match(entitySignals)
        if (!insight) continue

        // Skip se já existe cross-insight idêntico recente pra essa entity
        const exists = await this.crossInsightExists(orgId, insight.category, entityId)
        if (exists) continue

        const sourceIds = insight.source_signals.map(s => s.id)
        const entityName = insight.source_signals[0]?.entity_name ?? null
        const entityType = insight.source_signals[0]?.entity_type ?? 'product'

        drafts.push({
          analyzer:    'cross_intel',
          category:    insight.category,
          severity:    insight.severity,
          score:       insight.score,
          entity_type: entityType,
          entity_id:   entityId,
          entity_name: entityName,
          data:        { pattern_name: pattern.name, source_count: insight.source_signals.length },
          summary_pt:  insight.summary_pt,
          suggestion_pt: insight.suggestion_pt,
          expires_at:  expiresAt,
        })
        allSourceIds.push(sourceIds)
      }
    }

    if (drafts.length === 0) return 0

    // Insere com related_signals preenchido
    const inserted = await this.insertWithRelations(orgId, drafts, allSourceIds)
    if (inserted.length === 0) return 0

    // Roteia via AlertEngine pra gerar deliveries (igual analyzer normal)
    await this.engine.processMany(orgId, inserted)

    this.logger.log(`[org ${orgId}] cross_insights criados=${inserted.length}`)
    return inserted.length
  }

  private async crossInsightExists(orgId: string, category: string, entityId: string): Promise<boolean> {
    const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()
    const { count, error } = await supabaseAdmin
      .from('alert_signals')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('analyzer', 'cross_intel')
      .eq('category', category)
      .eq('entity_id', entityId)
      .gte('created_at', since)
    if (error) {
      this.logger.warn(`[exists] query falhou: ${error.message}`)
      return false
    }
    return (count ?? 0) > 0
  }

  /**
   * Insere drafts já com related_signals[] preenchido.
   * Não usa AlertSignalsService.insertMany porque ele não suporta
   * related_signals — wrapper é overkill, faz direto.
   */
  private async insertWithRelations(
    orgId: string, drafts: SignalDraft[], sourceIds: string[][],
  ): Promise<AlertSignal[]> {
    const rows = drafts.map((d, i) => ({
      organization_id: orgId,
      analyzer:        d.analyzer,
      category:        d.category,
      severity:        d.severity,
      score:           d.score,
      entity_type:     d.entity_type ?? null,
      entity_id:       d.entity_id   ?? null,
      entity_name:     d.entity_name ?? null,
      data:            d.data ?? {},
      summary_pt:      d.summary_pt,
      suggestion_pt:   d.suggestion_pt ?? null,
      expires_at:      d.expires_at   ?? null,
      status:          'new',
      related_signals: sourceIds[i],
      cross_insight:   d.category,
    }))

    const { data, error } = await supabaseAdmin
      .from('alert_signals')
      .insert(rows)
      .select()
    if (error) {
      this.logger.error(`[insert] cross_intel falhou: ${error.message}`)
      return []
    }
    // signalsSvc cache é via direto-DB; aqui retornamos o que foi gerado
    void this.signalsSvc  // suppress unused warning
    return (data ?? []) as AlertSignal[]
  }
}
