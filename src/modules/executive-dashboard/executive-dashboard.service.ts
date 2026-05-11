import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import type {
  DashboardSnapshot,
  DashboardRefreshType,
  RefreshResult,
  RefreshLog,
} from './executive-dashboard.types'

const REFRESH_INTERVAL_MS = 15 * 60 * 1000  // 15 minutos
const SALES_FIELDS = [
  'sales_7d_count', 'sales_7d_units', 'sales_7d_gmv',
  'sales_today_count', 'sales_today_gmv',
] as const

interface AggregatedRow {
  organization_id:                    string
  seller_id:                          number
  sales_7d_count:                     number | null
  sales_7d_units:                     number | null
  sales_7d_gmv:                       number | null
  sales_today_count:                  number | null
  sales_today_gmv:                    number | null
  total_active_listings:              number | null
  listings_quality_low:               number | null
  listings_quality_basic:             number | null
  listings_with_penalty:              number | null
  listings_incomplete_specs:          number | null
  active_campaigns:                   number | null
  campaigns_ending_today:             number | null
  campaigns_ending_this_week:         number | null
  campaign_recommendations_pending:   number | null
  campaign_high_opportunities:        number | null
  high_impact_recommendations_count:  number | null
  high_impact_total_estimated_brl:    number | null
}

/**
 * F11 Executive Dashboard — orchestration.
 *
 * Lê da VIEW `v_dashboard_aggregated_metrics` (single source of truth) +
 * snapshots de E2/E3/E4 (quando entrarem) e faz UPSERT em `ml_dashboard_summary`.
 *
 * - `refresh()` — full refresh de (org, seller). Cron 15min chama isso.
 * - `refreshSalesOnly()` — fast path pra tempo real (<3s) disparado quando
 *   frontend recebe `order:invalidate` e faz GET /executive/dashboard?fresh=sales.
 * - `getDashboard()` — lê o cache (instantâneo) + label do seller.
 *
 * Multi-conta: todas as queries filtram por `seller_id`. `ml_connections`
 * enumera os sellers da org.
 */
@Injectable()
export class ExecutiveDashboardService {
  private readonly logger = new Logger(ExecutiveDashboardService.name)

  // ── Read path ────────────────────────────────────────────────────────────

  /**
   * Retorna snapshots de todas as contas (sellers) conectadas pra org.
   * Se nenhuma conta tiver cache ainda, dispara refresh inline pra evitar
   * tela em branco no primeiro acesso.
   */
  async getDashboardsForOrg(
    orgId: string,
    opts: { fresh?: 'sales' | 'all' } = {},
  ): Promise<DashboardSnapshot[]> {
    const sellers = await this.listSellers(orgId)
    if (sellers.length === 0) return []

    // Fast path: se pediu refresh de vendas, roda em paralelo antes de ler
    if (opts.fresh === 'sales') {
      await Promise.all(sellers.map(s => this.refreshSalesOnly(orgId, s.seller_id)))
    } else if (opts.fresh === 'all') {
      await Promise.all(sellers.map(s => this.refresh(orgId, s.seller_id)))
    }

    const { data, error } = await supabaseAdmin
      .from('ml_dashboard_summary')
      .select('*')
      .eq('organization_id', orgId)
    if (error) {
      this.logger.error(`[dashboard] read fail org=${orgId.slice(0,8)}: ${error.message}`)
      return []
    }

    const rows = (data ?? []) as Array<DashboardSnapshot & Record<string, unknown>>
    const labels = new Map(sellers.map(s => [s.seller_id, s.nickname]))

    // Se algum seller ainda nao tem cache, dispara refresh lazy (best-effort,
    // próxima consulta acha o cache). Não bloqueia o response.
    const cachedSellers = new Set(rows.map(r => r.seller_id))
    for (const s of sellers) {
      if (!cachedSellers.has(s.seller_id)) {
        void this.refresh(orgId, s.seller_id).catch(err => {
          this.logger.warn(`[dashboard] lazy refresh fail seller=${s.seller_id}: ${(err as Error).message}`)
        })
      }
    }

    return rows.map(r => ({
      ...r,
      nickname: labels.get(r.seller_id) ?? null,
    }))
  }

  /** Logs de refresh (mais recentes primeiro). */
  async getRefreshLogs(orgId: string, limit = 50): Promise<RefreshLog[]> {
    const { data } = await supabaseAdmin
      .from('ml_dashboard_refresh_logs')
      .select('*')
      .eq('organization_id', orgId)
      .order('started_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200))
    return (data ?? []) as RefreshLog[]
  }

  // ── Write path ───────────────────────────────────────────────────────────

  /** Refresh completo de 1 (org, seller). Chamado pelo cron 15min e por POST manual. */
  async refresh(orgId: string, sellerId: number): Promise<RefreshResult> {
    return this.runRefresh(orgId, sellerId, 'full')
  }

  /** Fast path: só vendas (5 campos) — sub-100ms. Usado quando frontend recebe
   *  `order:invalidate` e faz GET /executive/dashboard?fresh=sales. */
  async refreshSalesOnly(orgId: string, sellerId: number): Promise<RefreshResult> {
    return this.runRefresh(orgId, sellerId, 'sales')
  }

  private async runRefresh(
    orgId: string,
    sellerId: number,
    kind: DashboardRefreshType,
  ): Promise<RefreshResult> {
    const t0 = Date.now()
    const logId = await this.openLog(orgId, sellerId, kind)

    try {
      const aggregated = await this.fetchAggregated(orgId, sellerId)
      if (!aggregated) {
        // VIEW não retornou row (seller sem dados ainda). Cria placeholder zerado
        // pra UI não ficar travada.
        await this.upsertEmpty(orgId, sellerId)
      } else if (kind === 'sales') {
        await this.upsertSalesOnly(aggregated)
      } else {
        await this.upsertFull(aggregated)
      }

      const duration = Date.now() - t0
      await this.closeLog(logId, 'completed', { duration_ms: duration, records_updated: 1 })
      return { org_id: orgId, seller_id: sellerId, refresh_type: kind, duration_ms: duration, api_calls_count: 0 }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[dashboard] refresh fail org=${orgId.slice(0,8)} seller=${sellerId} kind=${kind}: ${msg}`)
      await this.closeLog(logId, 'failed', { error_message: msg, duration_ms: Date.now() - t0 })
      throw err
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async listSellers(orgId: string): Promise<Array<{ seller_id: number; nickname: string | null }>> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id, nickname')
      .eq('organization_id', orgId)
    return ((data ?? []) as Array<{ seller_id: number; nickname: string | null }>)
  }

  private async fetchAggregated(orgId: string, sellerId: number): Promise<AggregatedRow | null> {
    const { data, error } = await supabaseAdmin
      .from('v_dashboard_aggregated_metrics')
      .select('*')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .maybeSingle()
    if (error) throw new Error(`fetchAggregated: ${error.message}`)
    return (data as AggregatedRow | null) ?? null
  }

  private async upsertFull(row: AggregatedRow): Promise<void> {
    const nextRefreshAt = new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString()

    // Lê current de reputação (E2), logística (E3) e visitas (E4) preenchidos
    // pelos respectivos crons. Mergea no summary pra UI ter tudo em 1 read.
    // Se ainda não foi sincronizada, fields ficam null/0 (UI mostra coverage alert).
    const reputation = await this.fetchReputationCurrent(row.organization_id, row.seller_id)
    const logistics  = await this.fetchLogisticsCurrent(row.organization_id, row.seller_id)
    const visits     = await this.fetchVisitsCurrent(row.organization_id, row.seller_id)
    const ads        = await this.fetchAdsCurrent(row.organization_id)

    const payload = {
      organization_id:                   row.organization_id,
      seller_id:                         row.seller_id,
      total_active_listings:             row.total_active_listings ?? 0,
      sales_7d_count:                    row.sales_7d_count ?? 0,
      sales_7d_units:                    row.sales_7d_units ?? 0,
      sales_7d_gmv:                      Number(row.sales_7d_gmv ?? 0),
      sales_today_count:                 row.sales_today_count ?? 0,
      sales_today_gmv:                   Number(row.sales_today_gmv ?? 0),
      sales_7d_avg_ticket:               (row.sales_7d_count ?? 0) > 0
                                          ? Number(row.sales_7d_gmv ?? 0) / (row.sales_7d_count as number)
                                          : null,
      listings_quality_low:              row.listings_quality_low ?? 0,
      listings_quality_basic:            row.listings_quality_basic ?? 0,
      listings_with_penalty:             row.listings_with_penalty ?? 0,
      listings_incomplete_specs:         row.listings_incomplete_specs ?? 0,
      active_campaigns:                  row.active_campaigns ?? 0,
      campaigns_ending_today:            row.campaigns_ending_today ?? 0,
      campaigns_ending_this_week:        row.campaigns_ending_this_week ?? 0,
      campaign_recommendations_pending:  row.campaign_recommendations_pending ?? 0,
      campaign_high_opportunities:       row.campaign_high_opportunities ?? 0,
      high_impact_recommendations_count: row.high_impact_recommendations_count ?? 0,
      high_impact_total_estimated_brl:   Number(row.high_impact_total_estimated_brl ?? 0),

      // E2 — reputação (null se ainda não sincronizada)
      reputation_level_id:               reputation?.level_id           ?? null,
      reputation_power_seller_status:    reputation?.power_seller_status ?? null,
      // Persistir como fração (consistente com snapshots). UI multiplica por 100.
      reputation_complaints_pct:         reputation?.claims_rate        ?? null,
      reputation_cancellations_pct:      reputation?.cancellations_rate ?? null,
      reputation_late_shipments_pct:     reputation?.delayed_handling_rate ?? null,
      reputation_color:                  reputation?.level_color        ?? null,

      // E3 — logística (0 se ainda não foi feito scan)
      shipments_to_dispatch_today:       logistics?.shipments_to_dispatch_today ?? 0,
      shipments_late:                    logistics?.shipments_late              ?? 0,
      flex_active_listings:              logistics?.flex_active_listings        ?? 0,

      // E4 — visitas (null se ainda não foi feito sync)
      visits_7d:                         visits?.visits_7d            ?? null,
      visits_7d_change_pct:              visits?.visits_7d_change_pct ?? null,
      conversion_rate_pct:               visits?.conversion_rate_pct  ?? null,

      // E5 — Ads (org-level; mesmo valor pra todos sellers da org)
      ads_spend_7d:                      ads?.ads_spend_7d               ?? 0,
      ads_revenue_7d:                    ads?.ads_revenue_7d             ?? 0,
      ads_clicks_7d:                     ads?.ads_clicks_7d              ?? 0,
      ads_impressions_7d:                ads?.ads_impressions_7d         ?? 0,
      ads_acos_7d:                       ads?.ads_acos_7d                ?? null,
      ads_roas_7d:                       ads?.ads_roas_7d                ?? null,
      ads_campaigns_active:              ads?.ads_campaigns_active       ?? 0,
      ads_campaigns_losing_money:        ads?.ads_campaigns_losing_money ?? 0,

      last_refresh_at:                   new Date().toISOString(),
      next_refresh_at:                   nextRefreshAt,
      updated_at:                        new Date().toISOString(),
    }
    const { error } = await supabaseAdmin
      .from('ml_dashboard_summary')
      .upsert(payload, { onConflict: 'organization_id,seller_id' })
    if (error) throw new Error(`upsertFull: ${error.message}`)
  }

  private async fetchReputationCurrent(orgId: string, sellerId: number): Promise<{
    level_id:              string | null
    level_color:           string | null
    power_seller_status:   string | null
    claims_rate:           number | null
    cancellations_rate:    number | null
    delayed_handling_rate: number | null
  } | null> {
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_current')
      .select('level_id, level_color, power_seller_status, claims_rate, cancellations_rate, delayed_handling_rate')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .maybeSingle()
    return (data as {
      level_id:              string | null
      level_color:           string | null
      power_seller_status:   string | null
      claims_rate:           number | null
      cancellations_rate:    number | null
      delayed_handling_rate: number | null
    } | null) ?? null
  }

  private async fetchLogisticsCurrent(orgId: string, sellerId: number): Promise<{
    shipments_to_dispatch_today: number
    shipments_late:              number
    flex_active_listings:        number
  } | null> {
    const { data } = await supabaseAdmin
      .from('ml_logistics_summary')
      .select('shipments_to_dispatch_today, open_delays_count, flex_eligible_count')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .maybeSingle()
    if (!data) return null
    const d = data as { shipments_to_dispatch_today: number; open_delays_count: number; flex_eligible_count: number }
    return {
      shipments_to_dispatch_today: d.shipments_to_dispatch_today,
      shipments_late:              d.open_delays_count,
      flex_active_listings:        d.flex_eligible_count,
    }
  }

  /** Soma visits_7d + change vs 7d anterior + conversion direto do cache ml_items_visits_daily. */
  private async fetchVisitsCurrent(orgId: string, sellerId: number): Promise<{
    visits_7d:                number
    visits_7d_change_pct:     number | null
    conversion_rate_pct:      number | null
  } | null> {
    const today = new Date().toISOString().slice(0, 10)
    const offset = (date: string, days: number) => {
      const d = new Date(`${date}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + days)
      return d.toISOString().slice(0, 10)
    }
    const since7d  = offset(today,  -7)
    const since14d = offset(today, -14)

    const sumWindow = async (from: string, to: string) => {
      const { data } = await supabaseAdmin
        .from('ml_items_visits_daily')
        .select('total_visits, total_orders')
        .eq('organization_id', orgId)
        .eq('seller_id',       sellerId)
        .gte('date', from)
        .lt('date',  to)
      if (!data || data.length === 0) return null
      const rows = data as Array<{ total_visits: number; total_orders: number }>
      return rows.reduce((acc, r) => ({
        total_visits: acc.total_visits + (r.total_visits ?? 0),
        total_orders: acc.total_orders + (r.total_orders ?? 0),
      }), { total_visits: 0, total_orders: 0 })
    }

    const [last7, prev7] = await Promise.all([
      sumWindow(since7d,  today),
      sumWindow(since14d, since7d),
    ])

    if (!last7 || last7.total_visits === 0) return null

    const change = prev7 && prev7.total_visits > 0
      ? ((last7.total_visits - prev7.total_visits) / prev7.total_visits) * 100
      : null
    const conversion = last7.total_visits > 0
      ? (last7.total_orders / last7.total_visits) * 100
      : null

    return {
      visits_7d:            last7.total_visits,
      visits_7d_change_pct: change,
      conversion_rate_pct:  conversion,
    }
  }

  private async upsertSalesOnly(row: AggregatedRow): Promise<void> {
    // Só os 5 campos de vendas + last_refresh_at. Se a row não existir ainda,
    // upsert cria com defaults (zeros) — não é problema porque o full refresh
    // seguinte vai popular o resto.
    const payload = {
      organization_id:    row.organization_id,
      seller_id:          row.seller_id,
      sales_7d_count:     row.sales_7d_count ?? 0,
      sales_7d_units:     row.sales_7d_units ?? 0,
      sales_7d_gmv:       Number(row.sales_7d_gmv ?? 0),
      sales_today_count:  row.sales_today_count ?? 0,
      sales_today_gmv:    Number(row.sales_today_gmv ?? 0),
      last_refresh_at:    new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    }
    const { error } = await supabaseAdmin
      .from('ml_dashboard_summary')
      .upsert(payload, { onConflict: 'organization_id,seller_id' })
    if (error) throw new Error(`upsertSalesOnly: ${error.message}`)
  }

  private async upsertEmpty(orgId: string, sellerId: number): Promise<void> {
    const { error } = await supabaseAdmin
      .from('ml_dashboard_summary')
      .upsert({
        organization_id:  orgId,
        seller_id:        sellerId,
        last_refresh_at:  new Date().toISOString(),
        next_refresh_at:  new Date(Date.now() + REFRESH_INTERVAL_MS).toISOString(),
        updated_at:       new Date().toISOString(),
      }, { onConflict: 'organization_id,seller_id' })
    if (error) throw new Error(`upsertEmpty: ${error.message}`)
  }

  private async openLog(orgId: string, sellerId: number, kind: DashboardRefreshType): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('ml_dashboard_refresh_logs')
      .insert({
        organization_id: orgId,
        seller_id:       sellerId,
        refresh_type:    kind,
        status:          'running',
        started_at:      new Date().toISOString(),
      })
      .select('id')
      .single()
    if (error) throw new Error(`openLog: ${error.message}`)
    return (data as { id: string }).id
  }

  private async closeLog(
    logId: string,
    status: 'completed' | 'failed' | 'partial',
    fields: { duration_ms?: number; error_message?: string; records_updated?: number },
  ): Promise<void> {
    await supabaseAdmin
      .from('ml_dashboard_refresh_logs')
      .update({
        status,
        duration_ms:      fields.duration_ms ?? null,
        records_updated:  fields.records_updated ?? 0,
        error_message:    fields.error_message ?? null,
        completed_at:     new Date().toISOString(),
      })
      .eq('id', logId)
  }

  /** Lê ml_ads_summary (org-level). Mesmo valor pra todos sellers da org. */
  private async fetchAdsCurrent(orgId: string): Promise<{
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
}

export { SALES_FIELDS }
