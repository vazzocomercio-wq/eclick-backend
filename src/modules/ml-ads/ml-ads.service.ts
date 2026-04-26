import { Injectable, Logger, HttpException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

interface AdvertiserRaw {
  advertiser_id: string | number
  account_name?: string
  site_id?: string
}
// Brand Ads / Product Ads / Display campaigns return slightly different
// field names. The unknown shape lets us probe each candidate at runtime.
type CampaignRaw = Record<string, unknown>
interface DailyMetricRow {
  campaign_id?: string | number
  date?: string
  clicks?:      number
  impressions?: number
  ctr?:         number
  cost?:        number
  conversions?: number
  attributed_revenue_brand_total?: number
  organic_revenue_brand_total?:    number
  total_revenue?:  number
  acos?:           number
  roas?:           number
}

@Injectable()
export class MlAdsService {
  private readonly logger = new Logger(MlAdsService.name)

  constructor(private readonly ml: MercadolivreService) {}

  // ── ML Ads API ────────────────────────────────────────────────────────────

  // ML Ads requires Api-Version: 1 on every call — without it the endpoints
  // return 404. Base path is /advertising (NOT /advertising/product_ads) and
  // campaign + metrics calls live under /brand_ads/.
  private async authHeaders(): Promise<Record<string, string>> {
    const { token } = await this.ml.getValidToken()
    return {
      Authorization: `Bearer ${token}`,
      'Api-Version': '1',
      Accept: 'application/json',
    }
  }

  // The path segment under /advertisers/{id}/ varies per product.
  private readonly PRODUCTS = ['PADS', 'BADS', 'DISPLAY'] as const
  private productPath(product: string): string {
    if (product === 'PADS')    return 'product_ads'
    if (product === 'BADS')    return 'brand_ads'
    if (product === 'DISPLAY') return 'display'
    return 'product_ads'
  }

  /** Returns the first advertiser found across PADS/BADS/DISPLAY (for the
   * page header). Never throws. */
  async getAdvertiser(): Promise<{ advertiser_id: string; account_name: string | null } | null> {
    const all = await this.getAllAdvertisers()
    const first = all[0]
    if (!first) return null
    return { advertiser_id: first.advertiser_id, account_name: first.account_name }
  }

  /** Fetches advertisers across all 3 product types in parallel.
   * Returns ALL (advertiser_id, product) pairs — same advertiser_id may
   * appear under multiple products, and each product slot owns DIFFERENT
   * campaigns, so we must NOT dedupe by advertiser_id alone. */
  async getAllAdvertisers(): Promise<Array<{ advertiser_id: string; product: string; account_name: string | null }>> {
    const headers = await this.authHeaders()
    const fetches = this.PRODUCTS.map(async product => {
      try {
        const { data } = await axios.get(`${ML_BASE}/advertising/advertisers`, {
          headers, params: { product_id: product },
        })
        const arr = Array.isArray(data?.advertisers) ? (data.advertisers as AdvertiserRaw[]) : []
        return arr.map(a => ({
          advertiser_id: String(a.advertiser_id),
          product,
          account_name:  a.account_name ?? null,
        }))
      } catch (e: any) {
        this.logger.warn(`[ml-ads.advertisers] ${product} ${e?.response?.status ?? ''} ${e?.message ?? ''}`)
        return []
      }
    })
    const results = (await Promise.all(fetches)).flat()
    // Dedupe only on (advertiser_id, product) tuple — keep both PADS and
    // BADS slots for the same numeric advertiser id.
    const seen = new Set<string>()
    const out: Array<{ advertiser_id: string; product: string; account_name: string | null }> = []
    for (const r of results) {
      const key = `${r.advertiser_id}|${r.product}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(r)
    }
    this.logger.log(`[ml-ads.advertisers] ${JSON.stringify(out)}`)
    return out
  }

  /** Paginated fetch of all campaigns for one advertiser/product.
   * Loops until ML returns fewer rows than the page size. */
  async getCampaignsRaw(advertiserId: string, product = 'PADS'): Promise<CampaignRaw[]> {
    const headers  = await this.authHeaders()
    const segment  = this.productPath(product)
    const url      = `${ML_BASE}/advertising/advertisers/${advertiserId}/${segment}/campaigns`
    const all: CampaignRaw[] = []
    const limit = 50
    let offset  = 0
    while (true) {
      const { data } = await axios.get(url, { headers, params: { limit, offset } })
      const list = Array.isArray(data?.results) ? data.results
                 : Array.isArray(data?.campaigns) ? data.campaigns
                 : Array.isArray(data) ? data
                 : []
      all.push(...(list as CampaignRaw[]))
      this.logger.log(`[ml-ads.paginate] ${product}/${advertiserId} offset=${offset} got=${list.length} total=${all.length}`)
      if (list.length < limit) break
      offset += limit
      if (offset > 5000) break // hard safety cap
    }
    return all
  }

  /**
   * Bulk-metrics call: ALL campaigns for one advertiser/product, daily.
   * Some accounts return nothing here and require a per-campaign call —
   * the caller falls back to getCampaignMetricsRaw when this is empty.
   */
  async getMetricsRaw(
    advertiserId: string,
    dateFrom:     string,
    dateTo:       string,
    product = 'PADS',
  ): Promise<DailyMetricRow[]> {
    const headers = await this.authHeaders()
    const segment = this.productPath(product)
    const { data } = await axios.get(
      `${ML_BASE}/advertising/advertisers/${advertiserId}/${segment}/campaigns/metrics`,
      {
        headers,
        params: {
          date_from:        dateFrom,
          date_to:          dateTo,
          aggregation_type: 'daily',
        },
      },
    )
    this.logger.log(`[ml-ads.metrics.raw] ${product}/${advertiserId} bulk: ${JSON.stringify(data).slice(0, 800)}`)
    return this.extractMetricRows(data)
  }

  /** Per-campaign daily metrics — fallback when the bulk endpoint returns
   * nothing. Stamps campaign_id onto rows that come back without it. */
  async getCampaignMetricsRaw(
    advertiserId: string,
    campaignId:   string,
    dateFrom:     string,
    dateTo:       string,
    product = 'PADS',
  ): Promise<DailyMetricRow[]> {
    const headers = await this.authHeaders()
    const segment = this.productPath(product)
    const { data } = await axios.get(
      `${ML_BASE}/advertising/advertisers/${advertiserId}/${segment}/campaigns/${campaignId}/metrics`,
      {
        headers,
        params: {
          date_from:        dateFrom,
          date_to:          dateTo,
          aggregation_type: 'daily',
        },
      },
    )
    this.logger.log(`[ml-ads.metrics.raw] ${product}/${advertiserId}/${campaignId} per-camp: ${JSON.stringify(data).slice(0, 600)}`)
    const rows = this.extractMetricRows(data)
    return rows.map(r => ({ ...r, campaign_id: r.campaign_id ?? campaignId }))
  }

  /** Tolerant on shape. PADS returns an array of per-campaign rows; BADS
   * returns a per-advertiser dashboard with a series per metric:
   *   { dashboard: { prints: [{x: "YYYY-MM-DD", y: 123}], clicks: [...], ... } }
   * For the dashboard shape we zip the arrays by date and emit one row per
   * day — caller stamps campaign_id afterwards (BADS = 1 campaign/advertiser). */
  private extractMetricRows(data: unknown): DailyMetricRow[] {
    if (Array.isArray(data)) return data as DailyMetricRow[]
    const dr = (data ?? {}) as Record<string, unknown>

    // BADS dashboard shape
    const dashboard = (dr.dashboard ?? dr.metrics_dashboard) as Record<string, Array<{ x: string; y: number }>> | undefined
    if (dashboard && typeof dashboard === 'object' && Array.isArray(dashboard.prints)) {
      const dates = dashboard.prints.map(p => p.x)
      return dates.map((date, i) => ({
        date,
        clicks:      Number(dashboard.clicks?.[i]?.y ?? 0),
        impressions: Number(dashboard.prints?.[i]?.y ?? 0),
        ctr:         Number(dashboard.ctr?.[i]?.y ?? 0),
        cost:        Number(dashboard.spend?.[i]?.y ?? dashboard.consumed_budget?.[i]?.y ?? 0),
        conversions: Number(
          dashboard.attribution_order_conversions?.[i]?.y
          ?? dashboard.conversions?.[i]?.y
          ?? 0
        ),
        total_revenue: Number(
          dashboard.attribution_order_amount?.[i]?.y
          ?? dashboard.revenue?.[i]?.y
          ?? 0
        ),
        roas: Number(dashboard.roas?.[i]?.y ?? 0),
        acos: Number(dashboard.acos?.[i]?.y ?? 0),
      } as DailyMetricRow))
    }

    if (Array.isArray(dr.metrics))   return dr.metrics as DailyMetricRow[]
    if (Array.isArray(dr.results))   return dr.results as DailyMetricRow[]
    if (Array.isArray(dr.data))      return dr.data as DailyMetricRow[]
    if (Array.isArray(dr.campaigns)) return dr.campaigns as DailyMetricRow[]
    return []
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** Fetch every advertiser across PADS/BADS/DISPLAY, then their campaigns
   * and last-30d metrics. Upserts everything into Supabase. */
  async syncAll(): Promise<{ ok: boolean; advertiser_id: string | null; campaigns: number; reports: number; message?: string }> {
    const advertisers = await this.getAllAdvertisers()
    if (advertisers.length === 0) {
      return { ok: false, advertiser_id: null, campaigns: 0, reports: 0, message: 'Conta sem ML Ads ativo' }
    }

    // Sweep any pre-existing rows with bad ids before this mapper was hardened.
    await supabaseAdmin
      .from('ml_ads_campaigns')
      .delete()
      .in('id', ['undefined', 'null', ''])

    const dateTo   = new Date().toISOString().slice(0, 10)
    const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    let totalCampaigns = 0
    let totalReports   = 0

    for (const adv of advertisers) {
      // Campaigns for this advertiser
      let campaigns: CampaignRaw[] = []
      try {
        campaigns = await this.getCampaignsRaw(adv.advertiser_id, adv.product)
      } catch (e: any) {
        this.logger.warn(`[ml-ads.sync] campaigns ${adv.product}/${adv.advertiser_id}: ${e?.response?.status ?? ''} ${e?.message}`)
        continue
      }
      if (campaigns.length === 0) continue

      // Real shape (Brand/Product Ads):
      //   { campaign_id, campaign_type, name, headline, status,
      //     budget: { amount, currency }, items: [{ item_id }, ...] }
      const campaignRows = campaigns
        .map(c => {
          const rawId = c.campaign_id ?? c.id
          if (rawId == null) return null
          const sId = String(rawId)
          if (sId === 'undefined' || sId === 'null' || !sId.trim()) return null
          const budget = c.budget as { amount?: number } | undefined
          const items  = Array.isArray(c.items) ? c.items : []
          return {
            id:            sId,
            advertiser_id: adv.advertiser_id,
            name:          (c.name ?? c.headline ?? '(sem nome)') as string,
            status:        (c.status ?? 'active') as string,
            daily_budget:  (budget?.amount ?? null) as number | null,
            type:          (c.campaign_type ?? c.type ?? adv.product) as string | null,
            start_date:    (c.start_date ?? null) as string | null,
            end_date:      (c.end_date ?? null) as string | null,
            items,
            synced_at:     new Date().toISOString(),
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (campaignRows.length === 0) continue

      const { error: upsertCampErr } = await supabaseAdmin
        .from('ml_ads_campaigns')
        .upsert(campaignRows, { onConflict: 'id' })
      if (upsertCampErr) {
        if (this.isMissingTableError(upsertCampErr)) {
          return { ok: false, advertiser_id: adv.advertiser_id, campaigns: 0, reports: 0, message: 'Tabelas ml_ads_* não existem — rode a migration 20260427_ml_ads.sql no Supabase' }
        }
        this.logger.warn(`[ml-ads.sync] upsert campaigns ${adv.advertiser_id}: ${upsertCampErr.message}`)
        continue
      }
      totalCampaigns += campaignRows.length

      // Metrics — first try the bulk endpoint, then fall back to per-campaign
      // calls if bulk returns nothing (some accounts only expose the latter).
      let metrics: DailyMetricRow[] = []
      try {
        metrics = await this.getMetricsRaw(adv.advertiser_id, dateFrom, dateTo, adv.product)
      } catch (e: any) {
        this.logger.warn(`[ml-ads.sync] bulk metrics ${adv.product}/${adv.advertiser_id}: ${e?.response?.status ?? ''} ${e?.message}`)
      }

      if (metrics.length === 0) {
        this.logger.log(`[ml-ads.sync] bulk empty — falling back to per-campaign metrics for ${campaignRows.length} campanha(s)`)
        for (const c of campaignRows) {
          try {
            const rows = await this.getCampaignMetricsRaw(adv.advertiser_id, c.id, dateFrom, dateTo, adv.product)
            metrics.push(...rows)
          } catch (e: any) {
            this.logger.warn(`[ml-ads.sync] per-campaign ${c.id}: ${e?.response?.status ?? ''} ${e?.message}`)
          }
        }
      }

      // BADS dashboard rows have no campaign_id (it's per-advertiser). When
      // there's exactly one campaign for this advertiser/product, stamp it.
      if (campaignRows.length === 1) {
        const onlyCid = campaignRows[0].id
        metrics = metrics.map(m => ({ ...m, campaign_id: m.campaign_id ?? onlyCid }))
      }

      // Real shape: { campaign_id, date, metrics: { prints, clicks, ctr,
      // cvr, acos, roas, attribution_order_conversions,
      // attribution_order_amount, consumed_budget, cost_per_clicks, leads } }
      // No validCampaignIds filter — accept any row that has cid + date,
      // even when all metrics are zero. Zero-rows still record activity-day.
      const reportRows = metrics
        .map(m => {
          const mr  = m as Record<string, unknown>
          const rawCid = m.campaign_id ?? (mr.campaignId as unknown)
          const cid = rawCid != null ? String(rawCid) : null
          const d   = (m.date ?? mr.day) as string | undefined
          if (!cid || !d || cid === 'undefined' || cid === 'null') return null
          const met = (mr.metrics ?? mr) as Record<string, unknown>
          return {
            campaign_id: cid,
            date:        d,
            clicks:      Number(met.clicks ?? 0),
            impressions: Number(met.prints ?? met.impressions ?? 0),
            ctr:         Number(met.ctr ?? 0),
            spend:       Number(met.consumed_budget ?? met.cost ?? met.spend ?? 0),
            conversions: Number(met.attribution_order_conversions ?? met.conversions ?? 0),
            revenue:     Number(met.attribution_order_amount ?? met.total_revenue ?? met.revenue ?? 0),
            roas:        Number(met.roas ?? 0),
            acos:        Number(met.acos ?? 0),
            synced_at:   new Date().toISOString(),
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (reportRows.length > 0) {
        const { error: rErr } = await supabaseAdmin
          .from('ml_ads_reports')
          .upsert(reportRows, { onConflict: 'campaign_id,date' })
        if (rErr) this.logger.warn(`[ml-ads.sync] reports upsert ${adv.advertiser_id}: ${rErr.message}`)
        else totalReports += reportRows.length
      }
    }

    this.logger.log(`[ml-ads.sync] ${advertisers.length} advertisers, ${totalCampaigns} campanhas, ${totalReports} reports`)
    return { ok: true, advertiser_id: advertisers[0].advertiser_id, campaigns: totalCampaigns, reports: totalReports }
  }

  // ── Read endpoints ────────────────────────────────────────────────────────

  /** True when Supabase says the table or relation isn't there — treat as
   * "no data yet" rather than a hard 500, since the SQL migration may not
   * have been applied in this environment. */
  private isMissingTableError(err: { code?: string; message?: string } | null): boolean {
    if (!err) return false
    const code = err.code ?? ''
    const msg  = (err.message ?? '').toLowerCase()
    return (
      code === 'PGRST205' || code === 'PGRST204' || code === '42P01' ||
      msg.includes('does not exist') ||
      msg.includes('schema cache') ||
      msg.includes('could not find the table')
    )
  }

  private emptySummary() {
    return {
      totals: {
        clicks: 0, impressions: 0, spend: 0,
        conversions: 0, revenue: 0,
        ctr: 0, roas: 0, acos: 0,
      },
      series: [] as Array<{ date: string; clicks: number; impressions: number; spend: number; conversions: number; revenue: number; ctr: number; roas: number; acos: number }>,
    }
  }

  async listCampaigns() {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, advertiser_id, name, status, daily_budget, type, start_date, end_date, synced_at')
      .order('name', { ascending: true })
    if (error) {
      if (this.isMissingTableError(error)) return []
      throw new HttpException(error.message, 500)
    }
    return data ?? []
  }

  async getSummaryReport(dateFrom: string, dateTo: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('date, clicks, impressions, spend, conversions, revenue')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: true })
    if (error) {
      if (this.isMissingTableError(error)) return this.emptySummary()
      throw new HttpException(error.message, 500)
    }

    const rows = data ?? []
    if (rows.length === 0) return this.emptySummary()

    // Aggregate per-day across all campaigns
    const byDate = new Map<string, { date: string; clicks: number; impressions: number; spend: number; conversions: number; revenue: number }>()
    for (const r of rows) {
      const key = r.date as string
      const cur = byDate.get(key) ?? { date: key, clicks: 0, impressions: 0, spend: 0, conversions: 0, revenue: 0 }
      cur.clicks      += Number(r.clicks ?? 0)
      cur.impressions += Number(r.impressions ?? 0)
      cur.spend       += Number(r.spend ?? 0)
      cur.conversions += Number(r.conversions ?? 0)
      cur.revenue     += Number(r.revenue ?? 0)
      byDate.set(key, cur)
    }
    const series = [...byDate.values()].map(d => ({
      ...d,
      ctr:  d.impressions > 0 ? d.clicks / d.impressions : 0,
      roas: d.spend > 0 ? d.revenue / d.spend : 0,
      acos: d.revenue > 0 ? d.spend / d.revenue : 0,
    }))

    const totals = series.reduce(
      (s, d) => ({
        clicks:      s.clicks + d.clicks,
        impressions: s.impressions + d.impressions,
        spend:       s.spend + d.spend,
        conversions: s.conversions + d.conversions,
        revenue:     s.revenue + d.revenue,
      }),
      { clicks: 0, impressions: 0, spend: 0, conversions: 0, revenue: 0 },
    )

    return {
      totals: {
        ...totals,
        ctr:  totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
        roas: totals.spend > 0 ? totals.revenue / totals.spend : 0,
        acos: totals.revenue > 0 ? totals.spend / totals.revenue : 0,
      },
      series,
    }
  }

  /** Per-campaign aggregation for the table view. */
  async getCampaignAggregation(dateFrom: string, dateTo: string) {
    const { data: campaigns, error: cErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, name, status, daily_budget, type')
    if (cErr) {
      if (this.isMissingTableError(cErr)) return []
      throw new HttpException(cErr.message, 500)
    }
    if (!campaigns?.length) return []

    const { data: reports, error: rErr } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('campaign_id, clicks, impressions, spend, conversions, revenue')
      .gte('date', dateFrom)
      .lte('date', dateTo)
    if (rErr && !this.isMissingTableError(rErr)) {
      throw new HttpException(rErr.message, 500)
    }

    const aggByCamp = new Map<string, { clicks: number; impressions: number; spend: number; conversions: number; revenue: number }>()
    for (const r of reports ?? []) {
      const cur = aggByCamp.get(r.campaign_id as string) ?? { clicks: 0, impressions: 0, spend: 0, conversions: 0, revenue: 0 }
      cur.clicks      += Number(r.clicks ?? 0)
      cur.impressions += Number(r.impressions ?? 0)
      cur.spend       += Number(r.spend ?? 0)
      cur.conversions += Number(r.conversions ?? 0)
      cur.revenue     += Number(r.revenue ?? 0)
      aggByCamp.set(r.campaign_id as string, cur)
    }

    return (campaigns ?? []).map(c => {
      const a = aggByCamp.get(c.id as string) ?? { clicks: 0, impressions: 0, spend: 0, conversions: 0, revenue: 0 }
      return {
        id:           c.id,
        name:         c.name,
        status:       c.status,
        daily_budget: c.daily_budget,
        type:         c.type,
        clicks:       a.clicks,
        impressions:  a.impressions,
        spend:        a.spend,
        conversions:  a.conversions,
        revenue:      a.revenue,
        ctr:          a.impressions > 0 ? a.clicks / a.impressions : 0,
        roas:         a.spend > 0 ? a.revenue / a.spend : 0,
        acos:         a.revenue > 0 ? a.spend / a.revenue : 0,
      }
    })
  }

  async getCampaignDailySeries(campaignId: string, dateFrom: string, dateTo: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('date, clicks, impressions, spend, conversions, revenue, roas, acos, ctr')
      .eq('campaign_id', campaignId)
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: true })
    if (error) {
      if (this.isMissingTableError(error)) return []
      throw new HttpException(error.message, 500)
    }
    return data ?? []
  }

  // ── Cron: 6h ──────────────────────────────────────────────────────────────

  @Cron('0 */6 * * *')
  async scheduledSync() {
    try {
      await this.syncAll()
    } catch (e: any) {
      this.logger.error(`[ml-ads.cron] ${e?.message}`)
    }
  }
}
