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
interface CampaignRaw {
  id: string | number
  name?: string
  status?: string
  daily_budget?: number
  type?: string
  start_date?: string
  end_date?: string
}
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

  /** Returns the first PADS advertiser for the connected ML account.
   * Never throws — caller treats null as "no advertiser configured". */
  async getAdvertiser(): Promise<{ advertiser_id: string; account_name: string | null } | null> {
    try {
      const headers = await this.authHeaders()
      const { data } = await axios.get(`${ML_BASE}/advertising/advertisers`, {
        headers,
        params: { product_id: 'PADS' },
      })
      const arr = Array.isArray(data?.advertisers) ? (data.advertisers as AdvertiserRaw[]) : []
      const first = arr[0]
      if (!first) return null
      return {
        advertiser_id: String(first.advertiser_id),
        account_name:  first.account_name ?? null,
      }
    } catch (e: any) {
      this.logger.warn(`[ml-ads.advertiser] ${e?.response?.status ?? ''} ${e?.message ?? ''}`)
      return null
    }
  }

  async getCampaignsRaw(advertiserId: string): Promise<CampaignRaw[]> {
    const headers = await this.authHeaders()
    const { data } = await axios.get(
      `${ML_BASE}/advertising/advertisers/${advertiserId}/brand_ads/campaigns`,
      { headers, params: { limit: 200 } },
    )
    // ML returns the list under .results (paginated) or directly under .campaigns
    const list = Array.isArray(data?.results) ? data.results
               : Array.isArray(data?.campaigns) ? data.campaigns
               : []
    return list as CampaignRaw[]
  }

  /**
   * One call returns daily metrics for ALL campaigns in the date range.
   * Each row carries campaign_id + date so we can group locally.
   */
  async getMetricsRaw(
    advertiserId: string,
    dateFrom:     string,
    dateTo:       string,
  ): Promise<DailyMetricRow[]> {
    const headers = await this.authHeaders()
    const { data } = await axios.get(
      `${ML_BASE}/advertising/advertisers/${advertiserId}/brand_ads/campaigns/metrics`,
      {
        headers,
        params: {
          date_from:        dateFrom,
          date_to:          dateTo,
          aggregation_type: 'daily',
        },
      },
    )
    // Tolerant on shape: ML may return the rows under .metrics, .results,
    // or directly as the body itself.
    const rows: unknown =
      Array.isArray(data?.metrics) ? data.metrics
      : Array.isArray(data?.results) ? data.results
      : Array.isArray(data) ? data
      : []
    return rows as DailyMetricRow[]
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** Fetch advertiser+campaigns+last-30d metrics and upsert into Supabase. */
  async syncAll(): Promise<{ ok: boolean; advertiser_id: string | null; campaigns: number; reports: number; message?: string }> {
    const advertiser = await this.getAdvertiser()
    if (!advertiser) return { ok: false, advertiser_id: null, campaigns: 0, reports: 0, message: 'Conta sem ML Ads ativo' }

    const campaigns = await this.getCampaignsRaw(advertiser.advertiser_id)

    if (campaigns.length === 0) return { ok: true, advertiser_id: advertiser.advertiser_id, campaigns: 0, reports: 0 }

    // Upsert campaigns
    const campaignRows = campaigns.map(c => ({
      id:            String(c.id),
      advertiser_id: advertiser.advertiser_id,
      name:          c.name ?? null,
      status:        c.status ?? null,
      daily_budget:  c.daily_budget ?? null,
      type:          c.type ?? null,
      start_date:    c.start_date ?? null,
      end_date:      c.end_date ?? null,
      synced_at:     new Date().toISOString(),
    }))

    const { error: upsertCampErr } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .upsert(campaignRows, { onConflict: 'id' })
    if (upsertCampErr) {
      if (this.isMissingTableError(upsertCampErr)) {
        return { ok: false, advertiser_id: advertiser.advertiser_id, campaigns: 0, reports: 0, message: 'Tabelas ml_ads_* não existem — rode a migration 20260427_ml_ads.sql no Supabase' }
      }
      throw new HttpException(`Falha upsert campaigns: ${upsertCampErr.message}`, 500)
    }

    // Pull last 30 days of metrics in ONE call (returns all campaigns aggregated daily).
    const dateTo   = new Date().toISOString().slice(0, 10)
    const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    let totalReports = 0
    try {
      const metrics = await this.getMetricsRaw(advertiser.advertiser_id, dateFrom, dateTo)
      const validCampaignIds = new Set(campaigns.map(c => String(c.id)))

      const reportRows = metrics
        .map(m => {
          const cid = m.campaign_id != null ? String(m.campaign_id) : null
          const d   = m.date
          if (!cid || !d || !validCampaignIds.has(cid)) return null
          return {
            campaign_id: cid,
            date:        d,
            clicks:      m.clicks ?? 0,
            impressions: m.impressions ?? 0,
            ctr:         m.ctr ?? 0,
            spend:       m.cost ?? 0,
            conversions: m.conversions ?? 0,
            revenue:     m.total_revenue ?? m.attributed_revenue_brand_total ?? 0,
            roas:        m.roas ?? 0,
            acos:        m.acos ?? 0,
            synced_at:   new Date().toISOString(),
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)

      if (reportRows.length > 0) {
        const { error: rErr } = await supabaseAdmin
          .from('ml_ads_reports')
          .upsert(reportRows, { onConflict: 'campaign_id,date' })
        if (rErr) this.logger.warn(`[ml-ads.sync] reports upsert: ${rErr.message}`)
        else totalReports = reportRows.length
      }
    } catch (e: any) {
      this.logger.warn(`[ml-ads.sync] metrics falharam: ${e?.response?.status ?? ''} ${e?.message}`)
    }

    this.logger.log(`[ml-ads.sync] ${campaigns.length} campanhas, ${totalReports} reports`)
    return { ok: true, advertiser_id: advertiser.advertiser_id, campaigns: campaigns.length, reports: totalReports }
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
