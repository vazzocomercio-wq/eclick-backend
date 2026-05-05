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
  //
  // Multi-tenant: TODAS as chamadas pra ML API recebem orgId — pegamos o
  // token específico da org via getTokenForOrg, não mais o connections[0]
  // global do getValidToken (que era o bug que misturava dados entre orgs).
  private async authHeaders(orgId: string): Promise<Record<string, string>> {
    const { token } = await this.ml.getTokenForOrg(orgId)
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
  async getAdvertiser(orgId: string): Promise<{ advertiser_id: string; account_name: string | null } | null> {
    const all = await this.getAllAdvertisers(orgId)
    const first = all[0]
    if (!first) return null
    return { advertiser_id: first.advertiser_id, account_name: first.account_name }
  }

  /** Fetches advertisers across all 3 product types in parallel.
   * Returns ALL (advertiser_id, product) pairs — same advertiser_id may
   * appear under multiple products, and each product slot owns DIFFERENT
   * campaigns, so we must NOT dedupe by advertiser_id alone. */
  async getAllAdvertisers(orgId: string): Promise<Array<{ advertiser_id: string; product: string; account_name: string | null }>> {
    const headers = await this.authHeaders(orgId)
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
    return out
  }

  /** Paginated fetch of all campaigns for one advertiser/product.
   * Loops until ML returns fewer rows than the page size. */
  async getCampaignsRaw(orgId: string, advertiserId: string, product = 'PADS'): Promise<CampaignRaw[]> {
    const headers  = await this.authHeaders(orgId)
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
      if (list.length < limit) break
      offset += limit
      if (offset > 5000) break // hard safety cap
    }
    return all
  }

  // PADS metrics: v2 /campaigns/search endpoint with Api-Version: 2.
  // BADS still uses the legacy /campaigns/metrics dashboard.
  private readonly PADS_METRIC_FIELDS = [
    'clicks', 'prints', 'ctr', 'cost', 'cpc',
    'acos', 'roas', 'units_quantity', 'total_amount',
  ].join(',')

  /**
   * Bulk-metrics call: ALL campaigns for one advertiser/product, daily.
   * BADS uses /campaigns/metrics (legacy v1 dashboard, aggregation_type=daily).
   * PADS uses /MLB/advertisers/{id}/product_ads/campaigns/search (v2) with
   * the metrics= csv. Returns DailyMetricRow[] either way.
   */
  async getMetricsRaw(
    orgId:        string,
    advertiserId: string,
    dateFrom:     string,
    dateTo:       string,
    product = 'PADS',
    _campaignIds: string[] = [],
  ): Promise<DailyMetricRow[]> {
    if (product === 'PADS') return this.getPadsMetrics(orgId, advertiserId, dateFrom, dateTo)

    // BADS / DISPLAY — legacy v1 dashboard endpoint.
    const headers = await this.authHeaders(orgId)
    const segment = this.productPath(product)
    const url     = `${ML_BASE}/advertising/advertisers/${advertiserId}/${segment}/campaigns/metrics`
    const params  = { date_from: dateFrom, date_to: dateTo, aggregation_type: 'daily' }
    try {
      const { data } = await axios.get(url, { headers, params })
      return this.extractMetricRows(data)
    } catch (e: any) {
      const status = e?.response?.status ?? '?'
      const msg    = e?.response?.data?.message ?? e?.message ?? ''
      this.logger.warn(`[ml-ads.bulk.${status}] ${product}/${advertiserId}: ${msg}`)
      throw e
    }
  }

  /** PADS metrics — ML's v2 API doesn't expose a native daily breakdown
   * on /campaigns or /items, but per-day calls (date_from=date_to=<day>)
   * return correct totals for that day. We loop the date range, fanning
   * out 5 days in parallel per batch, paginating items within each day,
   * and aggregating item rows into per-(campaign_id, date) records.
   *
   * Output: one DailyMetricRow per (campaign that had activity, day in
   * range), with derived ctr/acos/roas calculated from the totals. */
  private async getPadsMetrics(
    orgId:        string,
    advertiserId: string,
    dateFrom:     string,
    dateTo:       string,
  ): Promise<DailyMetricRow[]> {
    const { token } = await this.ml.getTokenForOrg(orgId)
    const headers = {
      Authorization: `Bearer ${token}`,
      'Api-Version': '2',
      Accept: 'application/json',
    }
    const url = `${ML_BASE}/advertising/MLB/advertisers/${advertiserId}/product_ads/items/search`

    // Build inclusive list of YYYY-MM-DD dates from dateFrom .. dateTo
    const dates: string[] = []
    {
      const cur = new Date(dateFrom + 'T00:00:00Z')
      const end = new Date(dateTo   + 'T00:00:00Z')
      while (cur.getTime() <= end.getTime()) {
        dates.push(cur.toISOString().slice(0, 10))
        cur.setUTCDate(cur.getUTCDate() + 1)
      }
    }

    type Agg = { clicks: number; prints: number; cost: number; total_amount: number; units_quantity: number }
    const out: DailyMetricRow[] = []
    let processedDays = 0
    let failedDays    = 0

    /** Fetch all items for a single day (paginated) and aggregate per
     * campaign_id. Returns the per-campaign Map for that day. */
    const fetchDay = async (date: string): Promise<Map<string, Agg>> => {
      const byCamp = new Map<string, Agg>()
      const limit = 50
      let offset  = 0
      while (true) {
        const { data } = await axios.get(url, {
          headers,
          params: {
            date_from: date,
            date_to:   date,
            metrics:   this.PADS_METRIC_FIELDS,
            limit,
            offset,
          },
        })
        const results: Array<Record<string, unknown>> = Array.isArray(data?.results) ? data.results : []
        for (const item of results) {
          const cid = String(item.campaign_id ?? '')
          if (!cid) continue
          const m = (item.metrics ?? {}) as Record<string, unknown>
          const cur = byCamp.get(cid) ?? { clicks: 0, prints: 0, cost: 0, total_amount: 0, units_quantity: 0 }
          cur.clicks         += Number(m.clicks ?? 0)
          cur.prints         += Number(m.prints ?? 0)
          cur.cost           += Number(m.cost ?? 0)
          cur.total_amount   += Number(m.total_amount ?? 0)
          cur.units_quantity += Number(m.units_quantity ?? 0)
          byCamp.set(cid, cur)
        }
        if (results.length < limit) break
        offset += limit
        if (offset > 5000) break // safety cap
      }
      return byCamp
    }

    // Fan out 5 days at a time so we don't slam the API serially or
    // saturate it with 30 parallel requests at once.
    const batchSize = 5
    for (let i = 0; i < dates.length; i += batchSize) {
      const batch = dates.slice(i, i + batchSize)
      const results = await Promise.allSettled(batch.map(d =>
        fetchDay(d).then(map => ({ date: d, map })),
      ))
      for (const r of results) {
        if (r.status !== 'fulfilled') { failedDays++; continue }
        processedDays++
        const { date, map } = r.value
        for (const [cid, agg] of map) {
          // Skip campaign-days with zero activity to keep the table lean.
          if (agg.prints === 0 && agg.clicks === 0 && agg.cost === 0) continue
          const ctr  = agg.prints > 0 ? agg.clicks / agg.prints : 0
          const acos = agg.total_amount > 0 ? agg.cost / agg.total_amount : 0
          const roas = agg.cost > 0 ? agg.total_amount / agg.cost : 0
          out.push({
            campaign_id:   cid,
            date,
            clicks:        agg.clicks,
            impressions:   agg.prints,
            ctr,
            cost:          agg.cost,
            conversions:   agg.units_quantity,
            total_revenue: agg.total_amount,
            roas,
            acos,
          })
        }
      }
    }

    this.logger.log(`[ml-ads.pads.search] ${advertiserId}: ${out.length} campanhas-dias gerados (${processedDays}/${dates.length} dias ok${failedDays ? `, ${failedDays} falharam` : ''})`)
    return out
  }

  /** Per-campaign daily metrics — fallback when the bulk endpoint returns
   * nothing. Stamps campaign_id onto rows that come back without it. */
  async getCampaignMetricsRaw(
    orgId:        string,
    advertiserId: string,
    campaignId:   string,
    dateFrom:     string,
    dateTo:       string,
    product = 'PADS',
  ): Promise<DailyMetricRow[]> {
    const headers = await this.authHeaders(orgId)
    const segment = this.productPath(product)

    let url: string
    let params: Record<string, string>
    if (product === 'PADS') {
      url = `${ML_BASE}/advertising/advertisers/${advertiserId}/${segment}/campaigns/${campaignId}`
      params = {
        date_from:   dateFrom,
        date_to:     dateTo,
        aggregation: 'daily',
        metrics:     this.PADS_METRIC_FIELDS,
      }
    } else {
      url = `${ML_BASE}/advertising/advertisers/${advertiserId}/${segment}/campaigns/${campaignId}/metrics`
      params = {
        date_from:        dateFrom,
        date_to:          dateTo,
        aggregation_type: 'daily',
      }
    }

    const { data } = await axios.get(url, { headers, params })
    const rows = this.extractMetricRows(data)
    return rows.map(r => ({ ...r, campaign_id: r.campaign_id ?? campaignId }))
  }

  // ── Campaign mutations (pause/resume/budget) ──────────────────────────────

  /**
   * Atualiza status e/ou daily_budget de uma campanha no ML Ads + DB local.
   * Resolve advertiser_id e type a partir do row local pra montar a URL certa.
   *
   * Status values aceitos pela API ML: 'active' | 'paused'.
   * Budget é decimal em BRL (mesma unidade do daily_budget).
   */
  async updateCampaign(
    orgId:      string,
    campaignId: string,
    patch:      { status?: 'active' | 'paused'; daily_budget?: number },
  ): Promise<{ id: string; status: string | null; daily_budget: number | null }> {
    if (patch.status === undefined && patch.daily_budget === undefined) {
      throw new HttpException('patch vazio', 400)
    }
    if (patch.status && !['active', 'paused'].includes(patch.status)) {
      throw new HttpException('status deve ser active ou paused', 400)
    }
    if (patch.daily_budget !== undefined && (patch.daily_budget < 0 || !Number.isFinite(patch.daily_budget))) {
      throw new HttpException('daily_budget inválido', 400)
    }

    // 1. Pega campaign do DB pra resolver advertiser_id + type
    const { data: camp, error: cErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, advertiser_id, type, status, daily_budget')
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .maybeSingle()
    if (cErr)  throw new HttpException(cErr.message, 500)
    if (!camp) throw new HttpException('campanha não encontrada', 404)

    const product = this.productFromType(camp.type as string | null)
    const segment = this.productPath(product)
    const headers = await this.authHeaders(orgId)
    const url     = `${ML_BASE}/advertising/advertisers/${camp.advertiser_id}/${segment}/campaigns/${campaignId}`

    // 2. Body do PATCH ML
    //    Brand/Product Ads aceita status (active/paused) e budget (objeto com amount).
    const body: Record<string, unknown> = {}
    if (patch.status !== undefined) body.status = patch.status
    if (patch.daily_budget !== undefined) body.budget = { amount: patch.daily_budget, currency: 'BRL' }

    try {
      await axios.put(url, body, { headers })
    } catch (e: any) {
      const status = e?.response?.status ?? '?'
      const detail = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? ''
      this.logger.warn(`[ml-ads.update.${status}] ${product}/${campaignId}: ${detail}`)
      throw new HttpException(`ML rejeitou: ${detail}`, status === 401 ? 401 : 400)
    }

    // 3. Espelha no DB local (sem esperar próximo sync)
    const dbPatch: Record<string, unknown> = { synced_at: new Date().toISOString() }
    if (patch.status !== undefined)        dbPatch.status        = patch.status
    if (patch.daily_budget !== undefined)  dbPatch.daily_budget  = patch.daily_budget

    const { data: updated, error: uErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .update(dbPatch)
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .select('id, status, daily_budget')
      .single()
    if (uErr) throw new HttpException(uErr.message, 500)

    this.logger.log(`[ml-ads.update] org=${orgId} ${campaignId} ${JSON.stringify(patch)}`)
    return updated as { id: string; status: string | null; daily_budget: number | null }
  }

  /**
   * Mapeia campaign.type (campo legado: 'PADS'|'BADS'|'DISPLAY' ou
   * 'product_ads'|'brand_ads' ou ainda apenas o sub-tipo do ML Ads que cai
   * no PADS por default) pro product code que a API ML aceita.
   */
  private productFromType(type: string | null): 'PADS' | 'BADS' | 'DISPLAY' {
    const t = (type ?? '').toUpperCase()
    if (t.includes('BAD') || t.includes('BRAND'))   return 'BADS'
    if (t.includes('DISPLAY'))                       return 'DISPLAY'
    return 'PADS'
  }

  /** Retorna a lista de items (item_ids) vinculados à campanha + lookup
   * pra products.ml_listing_id quando possível. */
  async getCampaignItems(orgId: string, campaignId: string): Promise<Array<{ item_id: string; product_id?: string; product_name?: string; sku?: string }>> {
    const { data: camp, error: cErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('items')
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .maybeSingle()
    if (cErr)  throw new HttpException(cErr.message, 500)
    if (!camp) return []

    const itemsRaw = (camp.items ?? []) as Array<unknown>
    const itemIds  = itemsRaw
      .map(i => (typeof i === 'string' ? i : (i as { item_id?: string })?.item_id))
      .filter((x): x is string => !!x)
    if (itemIds.length === 0) return []

    // Match com products via ml_listing_id pra enriquecer com nome+sku
    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, ml_listing_id, name, sku')
      .eq('organization_id', orgId)
      .in('ml_listing_id', itemIds)
    const byListing = new Map<string, { id: string; name: string | null; sku: string | null }>()
    for (const p of (products ?? []) as Array<{ id: string; ml_listing_id: string; name: string | null; sku: string | null }>) {
      byListing.set(p.ml_listing_id, p)
    }

    return itemIds.map(item_id => {
      const p = byListing.get(item_id)
      return {
        item_id,
        ...(p ? { product_id: p.id, product_name: p.name ?? undefined, sku: p.sku ?? undefined } : {}),
      }
    })
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
   * and last-30d metrics. Upserts everything into Supabase scoped to orgId. */
  async syncForOrg(orgId: string): Promise<{ ok: boolean; advertiser_id: string | null; campaigns: number; reports: number; message?: string }> {
    const advertisers = await this.getAllAdvertisers(orgId)
    if (advertisers.length === 0) {
      return { ok: false, advertiser_id: null, campaigns: 0, reports: 0, message: 'Conta sem ML Ads ativo' }
    }

    // Sweep any pre-existing rows with bad ids before this mapper was hardened.
    await supabaseAdmin
      .from('ml_ads_campaigns')
      .delete()
      .eq('organization_id', orgId)
      .in('id', ['undefined', 'null', ''])

    // ML Ads only accepts up to yesterday — today's row isn't closed yet.
    const dateTo   = new Date(Date.now() - 1 * 86_400_000).toISOString().slice(0, 10)
    const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    let totalCampaigns = 0
    let totalReports   = 0

    for (const adv of advertisers) {
      // Campaigns for this advertiser
      let campaigns: CampaignRaw[] = []
      try {
        campaigns = await this.getCampaignsRaw(orgId, adv.advertiser_id, adv.product)
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
            id:               sId,
            organization_id:  orgId,
            advertiser_id:    adv.advertiser_id,
            name:             (c.name ?? c.headline ?? '(sem nome)') as string,
            status:           (c.status ?? 'active') as string,
            daily_budget:     (budget?.amount ?? null) as number | null,
            type:             (c.campaign_type ?? c.type ?? adv.product) as string | null,
            start_date:       (c.start_date ?? null) as string | null,
            end_date:         (c.end_date ?? null) as string | null,
            items,
            synced_at:        new Date().toISOString(),
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

      // Metrics. PADS uses the v2 /campaigns/search endpoint which returns
      // both totals and metrics_daily in one call — no per-campaign fallback
      // needed. BADS still uses the legacy v1 dashboard; if it returns
      // empty, fall back to per-campaign calls (some BADS accounts only
      // expose the latter).
      let metrics: DailyMetricRow[] = []
      try {
        metrics = await this.getMetricsRaw(orgId, adv.advertiser_id, dateFrom, dateTo, adv.product)
      } catch (e: any) {
        this.logger.warn(`[ml-ads.sync] bulk metrics ${adv.product}/${adv.advertiser_id}: ${e?.response?.status ?? ''} ${e?.message}`)
      }

      if (metrics.length === 0 && adv.product !== 'PADS') {
        for (const c of campaignRows) {
          try {
            const rows = await this.getCampaignMetricsRaw(orgId, adv.advertiser_id, c.id, dateFrom, dateTo, adv.product)
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
            organization_id: orgId,
            campaign_id:     cid,
            date:            d,
            clicks:          Number(met.clicks ?? 0),
            impressions:     Number(met.prints ?? met.impressions ?? 0),
            ctr:             Number(met.ctr ?? 0),
            spend:           Number(met.consumed_budget ?? met.cost ?? met.spend ?? 0),
            conversions:     Number(met.attribution_order_conversions ?? met.conversions ?? 0),
            revenue:         Number(met.attribution_order_amount ?? met.total_revenue ?? met.revenue ?? 0),
            roas:            Number(met.roas ?? 0),
            acos:            Number(met.acos ?? 0),
            synced_at:       new Date().toISOString(),
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

    this.logger.log(`[ml-ads.sync] org=${orgId} ${advertisers.length} advertisers, ${totalCampaigns} campanhas, ${totalReports} reports`)
    return { ok: true, advertiser_id: advertisers[0].advertiser_id, campaigns: totalCampaigns, reports: totalReports }
  }

  /** Backwards-compat shim — algumas chamadas legadas ainda chamam syncAll().
   * Itera por todas as orgs com conexão ML; usado pelo cron e por scripts. */
  async syncAllOrgs(): Promise<{ orgs: number; total_campaigns: number; total_reports: number }> {
    const { data: conns, error } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
    if (error) {
      this.logger.error(`[ml-ads.syncAllOrgs] ${error.message}`)
      return { orgs: 0, total_campaigns: 0, total_reports: 0 }
    }
    const orgIds = [...new Set((conns ?? []).map(c => c.organization_id).filter(Boolean) as string[])]
    let total_campaigns = 0
    let total_reports   = 0
    for (const orgId of orgIds) {
      try {
        const r = await this.syncForOrg(orgId)
        total_campaigns += r.campaigns
        total_reports   += r.reports
      } catch (e: any) {
        this.logger.warn(`[ml-ads.syncAllOrgs] org=${orgId}: ${e?.message}`)
      }
    }
    this.logger.log(`[ml-ads.syncAllOrgs] orgs=${orgIds.length} campaigns=${total_campaigns} reports=${total_reports}`)
    return { orgs: orgIds.length, total_campaigns, total_reports }
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

  async listCampaigns(orgId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, advertiser_id, name, status, daily_budget, type, start_date, end_date, synced_at')
      .eq('organization_id', orgId)
      .order('name', { ascending: true })
    if (error) {
      if (this.isMissingTableError(error)) return []
      throw new HttpException(error.message, 500)
    }
    return data ?? []
  }

  async getSummaryReport(orgId: string, dateFrom: string, dateTo: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('date, clicks, impressions, spend, conversions, revenue')
      .eq('organization_id', orgId)
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
  async getCampaignAggregation(orgId: string, dateFrom: string, dateTo: string) {
    const { data: campaigns, error: cErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, name, status, daily_budget, type')
      .eq('organization_id', orgId)
    if (cErr) {
      if (this.isMissingTableError(cErr)) return []
      throw new HttpException(cErr.message, 500)
    }
    if (!campaigns?.length) return []

    const { data: reports, error: rErr } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('campaign_id, clicks, impressions, spend, conversions, revenue')
      .eq('organization_id', orgId)
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

  async getCampaignDailySeries(orgId: string, campaignId: string, dateFrom: string, dateTo: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('date, clicks, impressions, spend, conversions, revenue, roas, acos, ctr')
      .eq('organization_id', orgId)
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
      await this.syncAllOrgs()
    } catch (e: any) {
      this.logger.error(`[ml-ads.cron] ${e?.message}`)
    }
  }
}
