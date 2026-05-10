import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import type { AggregatedSignal, TaskType, TaskSeverity, ImpactArea } from '../ml-listing.types'

/**
 * Lê v_listing_aggregated_signals (VIEW que une F7/F8/F9) e cria/atualiza
 * registros em ml_listing_tasks. Idempotente: index único por
 * (org, seller, item, task_type) WHERE status IN (open/snoozed/in_progress)
 * garante 1 task ativa por tipo/item.
 *
 * Auto-resolve: tasks agregadas que NÃO foram vistas em 6h são marcadas
 * como `resolved_auto` (sinal sumiu da VIEW). Mantém lista viva.
 */
@Injectable()
export class ListingAggregationService {
  private readonly logger = new Logger(ListingAggregationService.name)

  /** Atualiza tasks lendo todos os sinais ativos da VIEW pra org/seller. */
  async aggregateSignals(orgId: string, sellerId?: number): Promise<{
    created: number
    updated: number
    resolved_auto: number
  }> {
    const t0 = Date.now()

    // 1. Lê VIEW
    let q = supabaseAdmin
      .from('v_listing_aggregated_signals')
      .select('*')
      .eq('organization_id', orgId)
      .not('task_type', 'is', null)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data: signals, error } = await q
    if (error) throw new Error(`[aggregation] VIEW read: ${error.message}`)

    let created = 0
    let updated = 0

    // 2. Pra cada sinal: upsert (atualiza last_seen / detection_count se existe)
    for (const raw of (signals ?? []) as AggregatedSignal[]) {
      const existing = await this.findActiveTask(raw)
      if (existing) {
        await supabaseAdmin
          .from('ml_listing_tasks')
          .update({
            last_seen_at: new Date().toISOString(),
            detection_count: (existing.detection_count ?? 1) + 1,
            severity: raw.severity,
            source_record_id: raw.source_record_id,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
        updated++
      } else {
        const newTask = this.buildTaskFromSignal(raw)
        const { error: insErr } = await supabaseAdmin
          .from('ml_listing_tasks')
          .insert(newTask)
        if (insErr) {
          this.logger.warn(`[aggregation] insert ${raw.ml_item_id}/${raw.task_type}: ${insErr.message}`)
        } else {
          created++
        }
      }
    }

    // 3. Auto-resolve: tasks agregadas que não viram sinal em >6h
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    let staleQ = supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_auto',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Sinal não detectado mais (auto-resolvido)',
      })
      .eq('organization_id', orgId)
      .like('source', 'aggregated_%')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')
    if (sellerId != null) staleQ = staleQ.eq('seller_id', sellerId)
    const { data: stale } = await staleQ
    const resolvedAuto = stale?.length ?? 0

    this.logger.log(
      `[aggregation] org=${orgId.slice(0, 8)}${sellerId ? ` seller=${sellerId}` : ''} ` +
      `signals=${signals?.length ?? 0} created=${created} updated=${updated} ` +
      `resolved_auto=${resolvedAuto} em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return { created, updated, resolved_auto: resolvedAuto }
  }

  private async findActiveTask(s: AggregatedSignal): Promise<{ id: string; detection_count: number | null } | null> {
    const { data } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', s.organization_id)
      .eq('seller_id', s.seller_id)
      .eq('ml_item_id', s.ml_item_id)
      .eq('task_type', s.task_type)
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()
    return (data as { id: string; detection_count: number | null } | null) ?? null
  }

  private buildTaskFromSignal(s: AggregatedSignal): Record<string, unknown> {
    const config = this.getTaskTypeConfig(s.task_type)
    const baseUrl = process.env.WEB_BASE_URL ?? 'https://eclick.app.br'

    return {
      organization_id: s.organization_id,
      seller_id: s.seller_id,
      ml_item_id: s.ml_item_id,
      product_id: s.product_id,
      task_type: s.task_type,
      task_title: config.title(s),
      task_description: config.description(s),
      source: s.source,
      source_record_id: s.source_record_id,
      source_table: s.source_table,
      severity: s.severity,
      priority_score: this.calculatePriority(s),
      impact_area: config.impact_area,
      deeplink_url: this.buildDeeplink(s, baseUrl),
      deeplink_module: config.module,
      status: 'open',
    }
  }

  private buildDeeplink(s: AggregatedSignal, baseUrl: string): string {
    switch (s.source) {
      case 'aggregated_quality':
        return `${baseUrl}/dashboard/ml-quality/items/${s.ml_item_id}`
      case 'aggregated_campaign':
        return `${baseUrl}/dashboard/ml-campaigns/recommendations/${s.source_record_id}`
      case 'aggregated_dropship':
        return `${baseUrl}/dashboard/dropship/products/${s.source_record_id}`
      default:
        return `${baseUrl}/dashboard/listings/items/${s.ml_item_id}`
    }
  }

  private calculatePriority(s: AggregatedSignal): number {
    // Heurística inicial: severity → score base
    const base = { critical: 90, high: 70, medium: 50, low: 30, info: 10 }[s.severity] ?? 30
    // Ajustes por contexto (refinar conforme dados de impacto reais)
    let adj = base
    if (s.task_type === 'QUALITY_LOW' && (s.quality_score ?? 100) < 30) adj += 5
    if (s.has_exposure_penalty) adj += 5
    return Math.min(100, adj)
  }

  private getTaskTypeConfig(taskType: TaskType): {
    title:        (s: AggregatedSignal) => string
    description:  (s: AggregatedSignal) => string
    module:       string
    impact_area:  ImpactArea[]
  } {
    const configs: Record<string, {
      title:        (s: AggregatedSignal) => string
      description:  (s: AggregatedSignal) => string
      module:       string
      impact_area:  ImpactArea[]
    }> = {
      QUALITY_LOW: {
        title: s => `Anúncio com qualidade baixa (${s.quality_score ?? '?'}/100)`,
        description: s => `Score ML: ${s.quality_score ?? '?'}/100. Resolver no Quality Center.`,
        module: 'quality_center',
        impact_area: ['exposure', 'sales'],
      },
      QUALITY_INCOMPLETE: {
        title: s => `${s.missing_attrs_count ?? '?'} atributos faltando`,
        description: () => 'Anúncio com ficha técnica incompleta. Resolver no Quality Center.',
        module: 'quality_center',
        impact_area: ['exposure'],
      },
      PROMOTION_HIGH_OPPORTUNITY: {
        title: () => 'Campanha disponível com alto potencial',
        description: () => 'Score de oportunidade ≥ 80. Avaliar no Campaign Center.',
        module: 'campaign_center',
        impact_area: ['sales', 'margin'],
      },
      PROMOTION_AVAILABLE: {
        title: () => 'Campanha disponível',
        description: () => 'Anúncio elegível para campanha. Avaliar no Campaign Center.',
        module: 'campaign_center',
        impact_area: ['sales'],
      },
      DROPSHIP_PARTNER_OUT_OF_STOCK: {
        title: () => 'Parceiro dropship sem estoque',
        description: () => 'Pausar anúncio ou trocar parceiro no Dropship Center.',
        module: 'dropship_center',
        impact_area: ['compliance', 'reputation'],
      },
    }
    return configs[taskType] ?? {
      title: () => `Tarefa ${taskType}`,
      description: () => '',
      module: 'listing_center',
      impact_area: ['sales'],
    }
  }

  /** Severity helper exportado pra outros scanners reusarem. */
  static severityToScore(severity: TaskSeverity): number {
    return { critical: 90, high: 70, medium: 50, low: 30, info: 10 }[severity]
  }
}
