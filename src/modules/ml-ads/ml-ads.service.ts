import { Injectable, Logger, HttpException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

const ML_ADS_BASE = 'https://api.mercadolibre.com/advertising/product_ads'

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
interface ReportMetrics {
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

  private async authHeaders(): Promise<Record<string, string>> {
    const { token } = await this.ml.getValidToken()
    return {
      Authorization: `Bearer ${token}`,
      'Api-Version': '2',
      Accept: 'application/json',
    }
  }

  /** Returns the first product_ads advertiser for the connected ML account. */
  async getAdvertiser(): Promise<{ advertiser_id: string; account_name: string | null } | null> {
    try {
      const headers = await this.authHeaders()
      const { data } = await axios.get(`${ML_ADS_BASE}/advertisers`, {
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
      const status = e?.response?.status ?? 500
      if (status === 401 || status === 403 || status === 404) return null
      throw new HttpException(e?.response?.data?.message ?? 'Erro ao buscar advertiser', status)
    }
  }

  async getCampaignsRaw(advertiserId: string): Promise<CampaignRaw[]> {
    const headers = await this.authHeaders()
    const { data } = await axios.get(
      `${ML_ADS_BASE}/advertisers/${advertiserId}/campaigns`,
      { headers, params: { limit: 200 } },
    )
    return Array.isArray(data?.results) ? (data.results as CampaignRaw[]) : []
  }

  /**
   * Per-day campaign metrics for the date range.
   * Mercado Libre returns one row per (campaign, date) when date_grouping=day.
   */
  async getCampaignReportRaw(
    advertiserId: string,
    campaignId:   string,
    dateFrom:     string,
    dateTo:       string,
  ): Promise<Array<ReportMetrics & { date: string }>> {
    const headers = await this.authHeaders()
    const { data } = await axios.get(
      `${ML_ADS_BASE}/advertisers/${advertiserId}/campaigns/${campaignId}/metrics`,
      {
        headers,
        params: {
          date_from:      dateFrom,
          date_to:        dateTo,
          date_grouping:  'day',
        },
      },
    )
    const rows = Array.isArray(data?.results) ? data.results : []
    return rows.map((r: ReportMetrics & { date?: string }) => ({
      date:        r.date ?? dateFrom,
      clicks:      r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr:         r.ctr ?? 0,
      cost:        r.cost ?? 0,
      conversions: r.conversions ?? 0,
      total_revenue: r.total_revenue ?? r.attributed_revenue_brand_total ?? 0,
      acos:        r.acos ?? 0,
      roas:        r.roas ?? 0,
    }))
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
    if (upsertCampErr) throw new HttpException(`Falha upsert campaigns: ${upsertCampErr.message}`, 500)

    // Pull last 30 days of metrics for each campaign
    const dateTo   = new Date().toISOString().slice(0, 10)
    const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

    let totalReports = 0
    for (const c of campaigns) {
      try {
        const metrics = await this.getCampaignReportRaw(advertiser.advertiser_id, String(c.id), dateFrom, dateTo)
        if (metrics.length === 0) continue
        const rows = metrics.map(m => ({
          campaign_id: String(c.id),
          date:        m.date,
          clicks:      m.clicks ?? 0,
          impressions: m.impressions ?? 0,
          ctr:         m.ctr ?? 0,
          spend:       m.cost ?? 0,
          conversions: m.conversions ?? 0,
          revenue:     m.total_revenue ?? 0,
          roas:        m.roas ?? 0,
          acos:        m.acos ?? 0,
          synced_at:   new Date().toISOString(),
        }))
        const { error: rErr } = await supabaseAdmin
          .from('ml_ads_reports')
          .upsert(rows, { onConflict: 'campaign_id,date' })
        if (rErr) {
          this.logger.warn(`[ml-ads.sync] campaign=${c.id}: ${rErr.message}`)
          continue
        }
        totalReports += rows.length
      } catch (e: any) {
        this.logger.warn(`[ml-ads.sync] campaign=${c.id} metrics falharam: ${e?.response?.status ?? ''} ${e?.message}`)
      }
    }

    this.logger.log(`[ml-ads.sync] ${campaigns.length} campanhas, ${totalReports} reports`)
    return { ok: true, advertiser_id: advertiser.advertiser_id, campaigns: campaigns.length, reports: totalReports }
  }

  // ── Read endpoints ────────────────────────────────────────────────────────

  async listCampaigns() {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, advertiser_id, name, status, daily_budget, type, start_date, end_date, synced_at')
      .order('name', { ascending: true })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getSummaryReport(dateFrom: string, dateTo: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('date, clicks, impressions, spend, conversions, revenue')
      .gte('date', dateFrom)
      .lte('date', dateTo)
      .order('date', { ascending: true })
    if (error) throw new HttpException(error.message, 500)

    const rows = data ?? []

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
    const { data: campaigns } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, name, status, daily_budget, type')

    const { data: reports } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('campaign_id, clicks, impressions, spend, conversions, revenue')
      .gte('date', dateFrom)
      .lte('date', dateTo)

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
    if (error) throw new HttpException(error.message, 500)
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
