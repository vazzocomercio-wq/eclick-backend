import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * F11 E5 — Ads Visibility.
 *
 * Camada de leitura sobre `ml_ads_campaigns` + `ml_ads_reports` (já existem
 * em prod, populadas pelo módulo ml-ads). NÃO chama API ML; só agrega.
 *
 * Multi-conta: dados são por (organization_id, advertiser_id). NÃO há
 * vínculo persistido advertiser_id ↔ seller_id, então agregamos por
 * organization_id. Ml_ads_summary tem 1 row por org.
 *
 * Threshold ACOS "losing money" default 30% (configurável via
 * ml_ads_summary.acos_threshold por org).
 */

const REFRESH_INTERVAL_MS = 60 * 60 * 1000  // 1h

@Injectable()
export class ExecutiveAdsService {
  private readonly logger = new Logger(ExecutiveAdsService.name)

  // ── Refresh ──────────────────────────────────────────────────────────────

  /**
   * Lê ml_ads_campaigns + ml_ads_reports e calcula o agregado 7d/14d.
   * Upsert em ml_ads_summary. Idempotente.
   */
  async refreshSummary(orgId: string): Promise<{
    has_advertiser:             boolean
    ads_spend_7d:               number
    ads_revenue_7d:             number
    ads_campaigns_losing_money: number
  }> {
    // 1. Threshold ACOS (config futura). Default 30%.
    const { data: existing } = await supabaseAdmin
      .from('ml_ads_summary')
      .select('acos_threshold')
      .eq('organization_id', orgId)
      .maybeSingle()
    const acosThreshold = (existing as { acos_threshold: number | null } | null)?.acos_threshold ?? 0.30

    // 2. Campanhas da org
    const { data: campaigns } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, advertiser_id, status')
      .eq('organization_id', orgId)
    const camps = (campaigns ?? []) as Array<{ id: string; advertiser_id: string; status: string }>

    const hasAdvertiser     = camps.length > 0
    const advertiserIds     = Array.from(new Set(camps.map(c => c.advertiser_id))).filter(Boolean)
    const campaignsActive   = camps.filter(c => c.status === 'active' || c.status === 'ACTIVE').length
    const campaignsPaused   = camps.filter(c => c.status === 'paused' || c.status === 'PAUSED').length

    // 3. Reports 7d/14d
    const today    = new Date().toISOString().slice(0, 10)
    const since7d  = this.dateOffset(today,  -7)
    const since14d = this.dateOffset(today, -14)

    const [last7, prev7] = await Promise.all([
      this.sumWindow(orgId, since7d,  today),
      this.sumWindow(orgId, since14d, since7d),
    ])

    const acos7d = last7.spend > 0 && last7.revenue > 0
      ? last7.spend / last7.revenue  // gasto / faturamento (mantemos como fração 0-1)
      : null
    const roas7d = last7.spend > 0
      ? last7.revenue / last7.spend
      : null
    const ctr7d = last7.impressions > 0
      ? (last7.clicks / last7.impressions) * 100
      : null

    const spendChange = prev7.spend > 0
      ? ((last7.spend - prev7.spend) / prev7.spend) * 100
      : null
    const revenueChange = prev7.revenue > 0
      ? ((last7.revenue - prev7.revenue) / prev7.revenue) * 100
      : null

    // 4. Campanhas losing money / winning — agregando reports 7d por campanha
    const { data: byCamp } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('campaign_id, spend, revenue')
      .eq('organization_id', orgId)
      .gte('date', since7d)
      .lt('date',  today)
    const perCampaign = new Map<string, { spend: number; revenue: number }>()
    for (const r of ((byCamp ?? []) as Array<{ campaign_id: string; spend: number | null; revenue: number | null }>)) {
      const prev = perCampaign.get(r.campaign_id) ?? { spend: 0, revenue: 0 }
      prev.spend   += Number(r.spend   ?? 0)
      prev.revenue += Number(r.revenue ?? 0)
      perCampaign.set(r.campaign_id, prev)
    }
    let losingMoney = 0
    let winning     = 0
    for (const stats of perCampaign.values()) {
      if (stats.spend <= 0) continue
      const acos = stats.revenue > 0 ? stats.spend / stats.revenue : Infinity
      const roas = stats.revenue / stats.spend
      if (acos > acosThreshold) losingMoney++
      if (roas > 3)             winning++
    }

    // 5. Upsert
    const payload = {
      organization_id:            orgId,
      ads_spend_7d:               last7.spend,
      ads_revenue_7d:             last7.revenue,
      ads_clicks_7d:              last7.clicks,
      ads_impressions_7d:         last7.impressions,
      ads_conversions_7d:         last7.conversions,
      ads_acos_7d:                acos7d,
      ads_roas_7d:                roas7d,
      ads_ctr_7d:                 ctr7d,
      ads_spend_change_pct:       spendChange,
      ads_revenue_change_pct:     revenueChange,
      ads_campaigns_active:       campaignsActive,
      ads_campaigns_paused:       campaignsPaused,
      ads_campaigns_losing_money: losingMoney,
      ads_campaigns_winning:      winning,
      has_advertiser:             hasAdvertiser,
      advertiser_ids:             advertiserIds,
      acos_threshold:             acosThreshold,
      last_refresh_at:            new Date().toISOString(),
      next_refresh_at:            new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString(),
    }
    const { error } = await supabaseAdmin
      .from('ml_ads_summary')
      .upsert(payload, { onConflict: 'organization_id' })
    if (error) throw new Error(`ads summary upsert: ${error.message}`)

    return {
      has_advertiser: hasAdvertiser,
      ads_spend_7d:   last7.spend,
      ads_revenue_7d: last7.revenue,
      ads_campaigns_losing_money: losingMoney,
    }
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  async getSummaryForOrg(orgId: string): Promise<unknown | null> {
    const { data } = await supabaseAdmin
      .from('ml_ads_summary')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    return data
  }

  /**
   * Leaderboard de campanhas 7d ordenado por ROAS asc (losers) ou desc (winners).
   * Inclui dados da campanha (name, type, status, daily_budget).
   */
  async getLeaderboard(
    orgId: string,
    kind: 'winners' | 'losers',
    limit = 10,
  ): Promise<Array<{
    campaign_id:   string
    name:          string | null
    type:          string | null
    status:        string | null
    daily_budget:  number | null
    advertiser_id: string | null
    spend_7d:      number
    revenue_7d:    number
    clicks_7d:     number
    impressions_7d: number
    acos_7d:       number | null
    roas_7d:       number | null
  }>> {
    const today   = new Date().toISOString().slice(0, 10)
    const since7d = this.dateOffset(today, -7)

    // Agrega 7d por campaign_id
    const { data: reports } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('campaign_id, spend, revenue, clicks, impressions')
      .eq('organization_id', orgId)
      .gte('date', since7d)
      .lt('date',  today)
    const agg = new Map<string, { spend: number; revenue: number; clicks: number; impressions: number }>()
    for (const r of ((reports ?? []) as Array<{ campaign_id: string; spend: number | null; revenue: number | null; clicks: number | null; impressions: number | null }>)) {
      const prev = agg.get(r.campaign_id) ?? { spend: 0, revenue: 0, clicks: 0, impressions: 0 }
      prev.spend       += Number(r.spend ?? 0)
      prev.revenue     += Number(r.revenue ?? 0)
      prev.clicks      += Number(r.clicks ?? 0)
      prev.impressions += Number(r.impressions ?? 0)
      agg.set(r.campaign_id, prev)
    }

    const rows = Array.from(agg.entries()).map(([campaign_id, m]) => ({
      campaign_id,
      spend_7d:      m.spend,
      revenue_7d:    m.revenue,
      clicks_7d:     m.clicks,
      impressions_7d: m.impressions,
      acos_7d:       m.spend > 0 && m.revenue > 0 ? m.spend / m.revenue : null,
      roas_7d:       m.spend > 0 ? m.revenue / m.spend : null,
    }))
      .filter(r => r.spend_7d > 0)
      .sort((a, b) => {
        if (kind === 'winners') {
          // ROAS desc — quem retorna mais por R$ investido
          return (b.roas_7d ?? 0) - (a.roas_7d ?? 0)
        }
        // losers: ACOS desc (maior gasto/receita ratio = pior). Inf primeiro (sem revenue).
        const aAcos = a.acos_7d ?? Infinity
        const bAcos = b.acos_7d ?? Infinity
        return bAcos - aAcos
      })
      .slice(0, Math.min(Math.max(limit, 1), 50))

    // Join com ml_ads_campaigns pra trazer name/type/status/daily_budget
    const ids = rows.map(r => r.campaign_id)
    if (ids.length === 0) return []
    const { data: campRows } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('id, advertiser_id, name, type, status, daily_budget')
      .eq('organization_id', orgId)
      .in('id', ids)
    const campMap = new Map<string, { advertiser_id: string; name: string | null; type: string | null; status: string | null; daily_budget: number | null }>()
    for (const c of ((campRows ?? []) as Array<{ id: string; advertiser_id: string; name: string | null; type: string | null; status: string | null; daily_budget: number | null }>)) {
      campMap.set(c.id, c)
    }

    return rows.map(r => {
      const c = campMap.get(r.campaign_id)
      return {
        ...r,
        name:          c?.name ?? null,
        type:          c?.type ?? null,
        status:        c?.status ?? null,
        daily_budget:  c?.daily_budget ?? null,
        advertiser_id: c?.advertiser_id ?? null,
      }
    })
  }

  /** Série temporal spend + revenue dos últimos N dias. */
  async getSpendVsRevenueChart(orgId: string, days = 30): Promise<Array<{
    date:    string
    spend:   number
    revenue: number
    clicks:  number
    roas:    number | null
  }>> {
    const today = new Date().toISOString().slice(0, 10)
    const since = this.dateOffset(today, -Math.max(days, 1))

    const { data } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('date, spend, revenue, clicks')
      .eq('organization_id', orgId)
      .gte('date', since)
      .lte('date', today)
    const rows = (data ?? []) as Array<{ date: string; spend: number | null; revenue: number | null; clicks: number | null }>

    // Agrega por dia
    const agg = new Map<string, { spend: number; revenue: number; clicks: number }>()
    for (const r of rows) {
      const prev = agg.get(r.date) ?? { spend: 0, revenue: 0, clicks: 0 }
      prev.spend   += Number(r.spend   ?? 0)
      prev.revenue += Number(r.revenue ?? 0)
      prev.clicks  += Number(r.clicks  ?? 0)
      agg.set(r.date, prev)
    }

    return Array.from(agg.entries())
      .map(([date, m]) => ({
        date,
        spend:   m.spend,
        revenue: m.revenue,
        clicks:  m.clicks,
        roas:    m.spend > 0 ? m.revenue / m.spend : null,
      }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }

  /** Pra dashboard service mergear ads_* no ml_dashboard_summary. */
  async fetchSummaryForDashboard(orgId: string): Promise<{
    ads_spend_7d:               number
    ads_revenue_7d:             number
    ads_clicks_7d:              number
    ads_impressions_7d:         number
    ads_acos_7d:                number | null
    ads_roas_7d:                number | null
    ads_campaigns_active:       number
    ads_campaigns_losing_money: number
  } | null> {
    const { data } = await supabaseAdmin
      .from('ml_ads_summary')
      .select('ads_spend_7d, ads_revenue_7d, ads_clicks_7d, ads_impressions_7d, ads_acos_7d, ads_roas_7d, ads_campaigns_active, ads_campaigns_losing_money')
      .eq('organization_id', orgId)
      .maybeSingle()
    return (data as {
      ads_spend_7d:               number
      ads_revenue_7d:             number
      ads_clicks_7d:              number
      ads_impressions_7d:         number
      ads_acos_7d:                number | null
      ads_roas_7d:                number | null
      ads_campaigns_active:       number
      ads_campaigns_losing_money: number
    } | null) ?? null
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async sumWindow(orgId: string, from: string, toExclusive: string): Promise<{
    spend:        number
    revenue:      number
    clicks:       number
    impressions:  number
    conversions:  number
  }> {
    const { data } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('spend, revenue, clicks, impressions, conversions')
      .eq('organization_id', orgId)
      .gte('date', from)
      .lt('date',  toExclusive)
    const rows = (data ?? []) as Array<{
      spend: number | null; revenue: number | null
      clicks: number | null; impressions: number | null; conversions: number | null
    }>
    return rows.reduce((acc, r) => ({
      spend:       acc.spend       + Number(r.spend       ?? 0),
      revenue:     acc.revenue     + Number(r.revenue     ?? 0),
      clicks:      acc.clicks      + Number(r.clicks      ?? 0),
      impressions: acc.impressions + Number(r.impressions ?? 0),
      conversions: acc.conversions + Number(r.conversions ?? 0),
    }), { spend: 0, revenue: 0, clicks: 0, impressions: 0, conversions: 0 })
  }

  private dateOffset(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }
}
