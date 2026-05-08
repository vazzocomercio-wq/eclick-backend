/** Sync principal do Quality Center.
 *
 *  Fluxo:
 *  1. Pega tokens de todas contas ML da org (multi-conta)
 *  2. Pra cada conta:
 *     a. /catalog_quality/status?seller_id=X&include_items=true (1 call retorna tudo)
 *     b. /users/:sellerId/items/search?tags=incomplete_technical_specs (penalizados)
 *     c. UPSERT snapshots por (org, seller, item)
 *     d. INSERT score_history quando score muda
 *  3. Recompute org_summary
 *  4. Loga em ml_quality_sync_logs
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlQualityApiClient, RateLimitedException } from './ml-quality-api.client'
import { computeScore, computeLevel, computeInternalPriority, computeDimAgg } from './ml-quality-scoring'
import type { MlCatalogQualityItem, MlQualitySyncResult } from './ml-quality.types'

interface SyncOpts {
  sellerId?: number  // se omitido, fan-out em todas contas da org
}

@Injectable()
export class MlQualitySyncService {
  private readonly logger = new Logger(MlQualitySyncService.name)

  constructor(
    private readonly ml:        MercadolivreService,
    private readonly mlQApi:    MlQualityApiClient,
  ) {}

  async syncOrg(orgId: string, opts: SyncOpts = {}): Promise<MlQualitySyncResult> {
    const t0 = Date.now()
    const tokens = opts.sellerId != null
      ? [await this.ml.getTokenForOrg(orgId, opts.sellerId)]
      : await this.ml.getAllTokensForOrg(orgId).catch(() => [])

    if (tokens.length === 0) throw new BadRequestException('ML nao conectado pra esta org')

    // Cria log de sync
    const { data: log, error: logErr } = await supabaseAdmin
      .from('ml_quality_sync_logs')
      .insert({
        organization_id: orgId,
        seller_id:       opts.sellerId ?? null,
        sync_type:       'full',
        status:          'running',
      })
      .select('id')
      .single()
    if (logErr || !log) throw new BadRequestException(`falha ao criar sync log: ${logErr?.message}`)

    const stats = { processed: 0, updated: 0, failed: 0, apiCalls: 0 }

    try {
      for (const t of tokens) {
        const result = await this.syncSeller(orgId, t.token, t.sellerId)
        stats.processed += result.processed
        stats.updated   += result.updated
        stats.failed    += result.failed
        stats.apiCalls  += result.apiCalls
      }

      // Recompute org summary (1 row por seller)
      for (const t of tokens) {
        await this.recomputeOrgSummary(orgId, t.sellerId)
      }

      const duration = Math.round((Date.now() - t0) / 1000)
      await supabaseAdmin
        .from('ml_quality_sync_logs')
        .update({
          items_processed:   stats.processed,
          items_updated:     stats.updated,
          items_failed:      stats.failed,
          api_calls_count:   stats.apiCalls,
          status:            stats.failed === 0 ? 'completed' : 'partial',
          duration_seconds:  duration,
          completed_at:      new Date().toISOString(),
        })
        .eq('id', log.id)

      this.logger.log(`[ml-quality.sync] org=${orgId} processed=${stats.processed} updated=${stats.updated} failed=${stats.failed} duration=${duration}s`)

      return { log_id: log.id, items_processed: stats.processed, items_updated: stats.updated, items_failed: stats.failed, api_calls_count: stats.apiCalls, duration_seconds: duration }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const duration = Math.round((Date.now() - t0) / 1000)
      await supabaseAdmin
        .from('ml_quality_sync_logs')
        .update({
          items_processed:   stats.processed,
          items_updated:     stats.updated,
          items_failed:      stats.failed,
          api_calls_count:   stats.apiCalls,
          status:            'failed',
          error_message:     msg,
          duration_seconds:  duration,
          completed_at:      new Date().toISOString(),
        })
        .eq('id', log.id)
      throw e
    }
  }

  /** Sync de UMA conta ML. Idempotente. */
  private async syncSeller(orgId: string, token: string, sellerId: number) {
    const stats = { processed: 0, updated: 0, failed: 0, apiCalls: 0 }

    let allItems: MlCatalogQualityItem[]
    try {
      const catalog = await this.mlQApi.getCatalogQualityStatus(token, sellerId)
      stats.apiCalls++
      // Achata items de todos os domains
      allItems = catalog.domains.flatMap(d => d.items.map(i => ({ ...i, _domain_id: d.domain_id }))) as any
    } catch (e) {
      if (e instanceof RateLimitedException) {
        this.logger.error(`[ml-quality.sync] rate limited seller=${sellerId} — pausando`)
        throw e
      }
      stats.failed++
      this.logger.error(`[ml-quality.sync] seller=${sellerId} catalog_quality falhou: ${(e as Error).message}`)
      return stats
    }

    // Items penalizados (tag = incomplete_technical_specs)
    let penalizedItemIds: Set<string>
    try {
      const r = await this.mlQApi.searchItemsByTag(token, sellerId, 'incomplete_technical_specs')
      stats.apiCalls += Math.ceil(r.total / 50)
      penalizedItemIds = new Set(r.ids)
    } catch (e) {
      if (e instanceof RateLimitedException) throw e
      this.logger.warn(`[ml-quality.sync] tags search falhou seller=${sellerId}: ${(e as Error).message}`)
      penalizedItemIds = new Set()
    }

    // Map de products por ml_item_id (pra preencher product_id no snapshot)
    const itemIds = allItems.map(i => i.item_id)
    const productMap = new Map<string, string>()
    if (itemIds.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products')
        .select('id, ml_listing_id, ml_item_id')
        .eq('organization_id', orgId)
        .or(`ml_listing_id.in.(${itemIds.map(id => `"${id}"`).join(',')}),ml_item_id.in.(${itemIds.map(id => `"${id}"`).join(',')})`)
      for (const p of (prods ?? []) as any[]) {
        if (p.ml_listing_id) productMap.set(p.ml_listing_id, p.id)
        if (p.ml_item_id)    productMap.set(p.ml_item_id, p.id)
      }
    }

    // UPSERT em batch — 100 items por vez pra nao estourar limite do PG
    const BATCH = 100
    for (let i = 0; i < allItems.length; i += BATCH) {
      const batch = allItems.slice(i, i + BATCH)
      const rows = batch.map(item => this.buildSnapshotRow(orgId, sellerId, item, productMap.get(item.item_id) ?? null, penalizedItemIds.has(item.item_id)))

      // Antes de upsert, busca scores anteriores pra detectar mudancas
      const itemIdsBatch = rows.map(r => r.ml_item_id)
      const { data: existing } = await supabaseAdmin
        .from('ml_quality_snapshots')
        .select('ml_item_id, ml_score, ml_level')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .in('ml_item_id', itemIdsBatch)
      const prevScores = new Map<string, { score: number; level: string }>()
      for (const e of (existing ?? []) as any[]) prevScores.set(e.ml_item_id, { score: e.ml_score, level: e.ml_level })

      const { error } = await supabaseAdmin
        .from('ml_quality_snapshots')
        .upsert(rows, { onConflict: 'organization_id,seller_id,ml_item_id' })
      if (error) {
        this.logger.error(`[ml-quality.sync] upsert batch ${i} falhou: ${error.message}`)
        stats.failed += rows.length
      } else {
        stats.updated += rows.length

        // INSERT score_history pras rows que mudaram (ou nao tinham)
        const historyRows = rows
          .filter(r => {
            const prev = prevScores.get(r.ml_item_id)
            return !prev || prev.score !== r.ml_score
          })
          .map(r => ({
            organization_id: orgId,
            seller_id:       sellerId,
            ml_item_id:      r.ml_item_id,
            ml_score:        r.ml_score,
            ml_level:        r.ml_level,
            pi_complete:     r.pi_complete,
            ft_complete:     r.ft_complete,
            all_complete:    r.all_complete,
          }))
        if (historyRows.length > 0) {
          await supabaseAdmin.from('ml_quality_score_history').insert(historyRows)
        }
      }
      stats.processed += rows.length
    }

    return stats
  }

  private buildSnapshotRow(orgId: string, sellerId: number, item: MlCatalogQualityItem & { _domain_id?: string }, productId: string | null, hasPenalty: boolean) {
    const adoption = item.adoption_status
    const score    = computeScore(adoption)
    const level    = computeLevel(score)
    const piAgg    = computeDimAgg(adoption.pi)
    const ftAgg    = computeDimAgg(adoption.ft)
    const allAgg   = computeDimAgg(adoption.all)
    const priority = computeInternalPriority(score, hasPenalty, allAgg.missing)

    return {
      organization_id:           orgId,
      seller_id:                 sellerId,
      product_id:                productId,
      ml_item_id:                item.item_id,
      ml_domain_id:              item._domain_id ?? item.domain_id ?? null,
      ml_score:                  score,
      ml_level:                  level,
      pi_complete:               adoption.pi.complete,
      pi_filled_count:           piAgg.filled,
      pi_missing_count:          piAgg.missing,
      pi_missing_attributes:     adoption.pi.missing_attributes ?? [],
      ft_complete:               adoption.ft.complete,
      ft_filled_count:           ftAgg.filled,
      ft_missing_count:          ftAgg.missing,
      ft_missing_attributes:     adoption.ft.missing_attributes ?? [],
      all_complete:              adoption.all.complete,
      all_filled_count:          allAgg.filled,
      all_missing_count:         allAgg.missing,
      all_missing_attributes:    adoption.all.missing_attributes ?? [],
      ml_tags:                   hasPenalty ? ['incomplete_technical_specs'] : [],
      has_exposure_penalty:      hasPenalty,
      penalty_reasons:           hasPenalty ? ['incomplete_technical_specs'] : [],
      pending_actions:           this.buildPendingActions(adoption),
      pending_count:             allAgg.missing,
      internal_priority_score:   priority.score,
      fix_complexity:            priority.complexity,
      estimated_score_after_fix: priority.estimated_score_after_fix,
      raw_adoption_status:       adoption,
      fetched_at:                new Date().toISOString(),
    }
  }

  private buildPendingActions(adoption: any): any[] {
    const actions: any[] = []
    if (!adoption.pi.complete && adoption.pi.missing_attributes.length > 0) {
      actions.push({ type: 'complete_pi', missing_attributes: adoption.pi.missing_attributes, impact: 'exposure_loss' })
    }
    if (!adoption.ft.complete && adoption.ft.missing_attributes.length > 0) {
      actions.push({ type: 'complete_ft', missing_attributes: adoption.ft.missing_attributes, impact: 'search_ranking' })
    }
    return actions
  }

  /** Recompute org_summary (1 row por seller) com agregados dos snapshots. */
  private async recomputeOrgSummary(orgId: string, sellerId: number): Promise<void> {
    const { data: snaps, error } = await supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_score, ml_level, has_exposure_penalty, pending_count, ml_domain_id, all_missing_attributes, estimated_score_after_fix')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
    if (error || !snaps) return

    const total       = snaps.length
    const basic       = snaps.filter(s => s.ml_level === 'basic').length
    const satisfact   = snaps.filter(s => s.ml_level === 'satisfactory').length
    const profess     = snaps.filter(s => s.ml_level === 'professional').length
    const complete    = snaps.filter(s => s.ml_score === 100).length
    const incomplete  = snaps.filter(s => (s.ml_score ?? 0) < 100).length
    const withPen     = snaps.filter(s => s.has_exposure_penalty).length
    const totalPend   = snaps.reduce((s, x) => s + (x.pending_count ?? 0), 0)

    const scores = snaps.map(s => s.ml_score ?? 0).filter(s => s > 0).sort((a, b) => a - b)
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const median = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : 0

    const quickWins = snaps.filter(s => (s.ml_score ?? 0) >= 85 && (s.ml_score ?? 0) < 100)
    const qwGain    = quickWins.reduce((s, x) => s + Math.max(0, (x.estimated_score_after_fix ?? 0) - (x.ml_score ?? 0)), 0)

    // Top dominios criticos
    const domainAgg = new Map<string, { incomplete: number; sumScore: number; count: number }>()
    for (const s of snaps) {
      const d = s.ml_domain_id ?? 'unknown'
      const cur = domainAgg.get(d) ?? { incomplete: 0, sumScore: 0, count: 0 }
      if ((s.ml_score ?? 0) < 100) cur.incomplete++
      cur.sumScore += s.ml_score ?? 0
      cur.count++
      domainAgg.set(d, cur)
    }
    const topDomains = Array.from(domainAgg.entries())
      .map(([domain_id, v]) => ({ domain_id, items_incomplete: v.incomplete, avg_score: v.count > 0 ? Math.round(v.sumScore / v.count) : 0 }))
      .filter(d => d.items_incomplete > 0)
      .sort((a, b) => b.items_incomplete - a.items_incomplete)
      .slice(0, 10)

    // Top atributos missing
    const attrCount = new Map<string, number>()
    for (const s of snaps) {
      for (const a of (s.all_missing_attributes ?? [])) {
        attrCount.set(a, (attrCount.get(a) ?? 0) + 1)
      }
    }
    const topMissing = Array.from(attrCount.entries())
      .map(([attribute, missing_in_items]) => ({ attribute, missing_in_items }))
      .sort((a, b) => b.missing_in_items - a.missing_in_items)
      .slice(0, 20)

    await supabaseAdmin
      .from('ml_quality_org_summary')
      .upsert({
        organization_id:            orgId,
        seller_id:                  sellerId,
        total_items:                total,
        items_basic:                basic,
        items_satisfactory:         satisfact,
        items_professional:         profess,
        items_complete:             complete,
        items_incomplete:           incomplete,
        items_with_penalty:         withPen,
        avg_score:                  Math.round(avg * 100) / 100,
        median_score:               median,
        total_pending_actions:      totalPend,
        top_critical_domains:       topDomains,
        top_missing_attributes:     topMissing,
        quick_wins_count:           quickWins.length,
        quick_wins_estimated_gain:  qwGain,
        last_sync_at:               new Date().toISOString(),
        updated_at:                 new Date().toISOString(),
      }, { onConflict: 'organization_id,seller_id' })
  }
}
