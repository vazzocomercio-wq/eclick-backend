import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../../common/supabase'
import { MercadolivreService } from '../../../mercadolivre/mercadolivre.service'
import { GeoTelemetryService } from '../../geo-score/services/geo-telemetry.service'
import { BaselineService } from './baseline.service'
import { ImpactMetricDelta, ImpactReport, ImpactVerdict, ListingImpact } from '../../shared/types'

const WASH_START = 3   // D+3 — começo do wash period
const WASH_END   = 16  // D+16 — fim da janela de medição (inclusive)
const THRESHOLD_PCT = 20 // melhoria mínima por métrica pra contar
const MIN_WINS = 3       // mínimo de anúncios "win" pra veredito GO (≥3/5)
const DAY = 86400_000

/**
 * ImpactTracker (Dia 14) — fecha o loop do piloto: re-captura visitas/unidades/
 * receita na janela D+3..D+16 e compara com o baseline pré-apply. Decide o
 * Risco 2 (GEO Score melhora venda?). 100% leitura — não toca no ML.
 */
@Injectable()
export class ImpactTrackerService {
  private readonly logger = new Logger(ImpactTrackerService.name)

  constructor(
    private readonly baseline:     BaselineService,
    private readonly mercadolivre: MercadolivreService,
    private readonly telemetry:    GeoTelemetryService,
  ) {}

  /** Relatório de impacto de todos os anúncios aplicados (com baseline) da org. */
  async report(orgId: string, userId?: string): Promise<ImpactReport> {
    // 1) Baselines da org (1 por listing, o mais recente).
    const { data: bls } = await supabaseAdmin
      .from('ai_optimizer_baselines')
      .select('id, listing_id, optimizer_id, version_id, snapshot_json, captured_at')
      .eq('org_id', orgId).order('captured_at', { ascending: false })
    const baselines = (bls as BaselineRow[] | null ?? [])
    const seen = new Set<string>()
    const latest = baselines.filter(b => (seen.has(b.listing_id) ? false : (seen.add(b.listing_id), true)))

    if (latest.length === 0) {
      return { generated_at: new Date().toISOString(), total: 0, measured: 0, pending: 0, win_count: 0, threshold: MIN_WINS, delta_pct: THRESHOLD_PCT, verdict: 'pending', listings: [] }
    }

    // 2) Datas de apply (versions) + status (rolled_back) + sku/product_id.
    const versionIds  = latest.map(b => b.version_id).filter(Boolean) as string[]
    const optimizerIds = latest.map(b => b.optimizer_id).filter(Boolean) as string[]
    const listingIds  = latest.map(b => b.listing_id)

    const [{ data: vers }, { data: opts }, { data: pls }] = await Promise.all([
      versionIds.length
        ? supabaseAdmin.from('ai_optimizer_versions').select('id, changed_at').in('id', versionIds)
        : Promise.resolve({ data: [] as Array<{ id: string; changed_at: string }> }),
      optimizerIds.length
        ? supabaseAdmin.from('ai_optimizer_results').select('id, status').in('id', optimizerIds)
        : Promise.resolve({ data: [] as Array<{ id: string; status: string }> }),
      supabaseAdmin.from('product_listings').select('listing_id, product_id, products(sku)').in('listing_id', listingIds),
    ])
    const applyDateBy = new Map((vers as Array<{ id: string; changed_at: string }> ?? []).map(v => [v.id, v.changed_at]))
    const statusBy    = new Map((opts as Array<{ id: string; status: string }> ?? []).map(o => [o.id, o.status]))
    const plBy = new Map((pls as Array<{ listing_id: string; product_id: string; products?: { sku?: string } | { sku?: string }[] }> ?? [])
      .map(p => [p.listing_id, { productId: p.product_id, sku: Array.isArray(p.products) ? p.products[0]?.sku : p.products?.sku }]))

    // 3) Avalia cada anúncio.
    const now = Date.now()
    const listings: ListingImpact[] = []
    for (const b of latest) {
      const snap = (b.snapshot_json ?? {}) as SnapshotJson
      const applyIso = (b.version_id && applyDateBy.get(b.version_id)) || b.captured_at
      const applyTs  = new Date(applyIso).getTime()
      const fromDate = isoDate(applyTs + WASH_START * DAY)
      const toDate   = isoDate(applyTs + WASH_END * DAY)
      const windowToEnd = new Date(`${toDate}T23:59:59.999Z`).getTime()
      const elapsed = now > windowToEnd
      const daysRemaining = elapsed ? 0 : Math.ceil((windowToEnd - now) / DAY)
      const rolledBack = (b.optimizer_id && statusBy.get(b.optimizer_id)) === 'rolled_back'
      const pl = plBy.get(b.listing_id)

      const base = {
        listing_id: b.listing_id, optimizer_id: b.optimizer_id, sku: pl?.sku ?? null,
        apply_date: applyIso, window_from: fromDate, window_to: toDate,
        window_elapsed: elapsed, days_remaining: daysRemaining,
        geo_score_before: numOrNull(snap.geo_score),
      }
      const before = { visits: num(snap.visits_14d), units: num(snap.units_14d), revenue: num(snap.revenue_14d) }

      if (rolledBack) {
        listings.push({ ...base, metrics: emptyMetrics(before), is_win: false, note: 'rolled_back' })
        continue
      }
      if (!elapsed) {
        listings.push({ ...base, metrics: emptyMetrics(before), is_win: false, note: 'window_open' })
        continue
      }
      // Janela fechada → mede o "depois".
      let token: string | undefined
      try { token = (await this.ownerToken(orgId, b.listing_id)) ?? undefined } catch { token = undefined }
      const post = await this.baseline.capturePostWindow({
        orgId, listingId: b.listing_id, productId: pl?.productId, token, fromDate, toDate,
      })
      const metrics: ImpactMetricDelta[] = [
        delta('visits',  before.visits,  post.visits),
        delta('units',   before.units,   post.units),
        delta('revenue', before.revenue, post.revenue),
      ]
      const isWin = metrics.some(m => m.improved)
      listings.push({ ...base, metrics, is_win: isWin, note: pl?.productId ? null : 'no_product' })
    }

    // 4) Agrega + veredito.
    const active   = listings.filter(l => l.note !== 'rolled_back')
    const measured = active.filter(l => l.window_elapsed)
    const pending  = active.filter(l => !l.window_elapsed)
    const winCount = measured.filter(l => l.is_win).length
    const verdict: ImpactVerdict = pending.length > 0 ? 'pending' : (winCount >= MIN_WINS ? 'GO' : 'NO_GO')

    const report: ImpactReport = {
      generated_at: new Date().toISOString(),
      total: active.length, measured: measured.length, pending: pending.length,
      win_count: winCount, threshold: MIN_WINS, delta_pct: THRESHOLD_PCT, verdict, listings,
    }

    if (verdict !== 'pending') {
      await this.telemetry.emit({
        orgId, userId: userId ?? '', jobId: 'impact', feature: 'geo_optimizer',
        eventName: 'geo_optimizer.impact_measured',
        properties: { verdict, measured: measured.length, win_count: winCount, threshold: MIN_WINS },
      }).catch(() => {})
    }
    this.logger.log(`[impact] org=${orgId} veredito=${verdict} wins=${winCount}/${measured.length} (pend=${pending.length})`)
    return report
  }

  /** Token da conta DONA do anúncio (multi-conta) — só leitura de visitas. */
  private async ownerToken(orgId: string, itemId: string): Promise<string | null> {
    const tokens = await this.mercadolivre.getAllTokensForOrg(orgId)
    for (const { token } of tokens) {
      try {
        const { data } = await axios.get(`https://api.mercadolibre.com/items/${itemId}?attributes=seller_id`, { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 })
        const sellerId = Number((data as { seller_id?: number }).seller_id)
        if (sellerId) { const owner = await this.mercadolivre.getTokenForOrg(orgId, sellerId); return owner.token }
      } catch { /* tenta o próximo */ }
    }
    return null
  }
}

interface BaselineRow { id: string; listing_id: string; optimizer_id: string | null; version_id: string | null; snapshot_json: unknown; captured_at: string }
interface SnapshotJson { geo_score?: number | null; visits_14d?: number; units_14d?: number; revenue_14d?: number }

function isoDate(ts: number): string { return new Date(ts).toISOString().slice(0, 10) }
function num(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }
function numOrNull(v: unknown): number | null { const n = Number(v); return Number.isFinite(n) ? n : null }

function delta(metric: ImpactMetricDelta['metric'], before: number, after: number): ImpactMetricDelta {
  const pct = before > 0 ? +(((after - before) / before) * 100).toFixed(1) : null
  return { metric, before, after, delta_pct: pct, improved: pct !== null && pct >= THRESHOLD_PCT }
}
function emptyMetrics(before: { visits: number; units: number; revenue: number }): ImpactMetricDelta[] {
  return (['visits', 'units', 'revenue'] as const).map(m => ({ metric: m, before: before[m], after: null, delta_pct: null, improved: false }))
}
