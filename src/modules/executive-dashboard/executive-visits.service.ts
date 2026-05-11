import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

/**
 * F11 E4 — Visitas + Conversão.
 *
 * Sync diário de visitas via /users/{id}/items_visits/time_window
 * (smoke confirmou: date_from/date_to ISO retorna 400, então usa time_window).
 *
 * Para cada dia retornado:
 *  1. INSERT/UPDATE em ml_items_visits_daily com total_visits + visits_detail
 *  2. Cruzamento com orders (sale_price/quantity/created_at) pra conversion
 *  3. Comparação com prev_day e same_day_last_week
 *
 * Multi-conta: sempre passa sellerId em getTokenForOrg.
 */

interface MlVisitsDetail { company?: string; quantity?: number }
interface MlVisitsDay    { date: string; total: number; visits_detail?: MlVisitsDetail[] }
interface MlVisitsResp   {
  total_visits?: number
  date_from?:    string
  date_to?:      string
  last?:         number
  unit?:         string
  results?:      MlVisitsDay[]
}

@Injectable()
export class ExecutiveVisitsService {
  private readonly logger = new Logger(ExecutiveVisitsService.name)

  constructor(private readonly ml: MercadolivreService) {}

  /**
   * Sincroniza últimos N dias de visitas. Usa /time_window por ser robusto;
   * fetches 1 chamada cobrindo o período todo. Default: 30 dias.
   */
  async syncRecent(orgId: string, sellerId: number, days = 30): Promise<{
    days_synced:    number
    total_visits:   number
  }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    const lastN = Math.min(Math.max(days, 1), 60)

    const { data } = await axios.get<MlVisitsResp>(
      `https://api.mercadolibre.com/users/${sellerId}/items_visits/time_window?last=${lastN}&unit=day`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
    )

    const rawResults = data.results ?? []
    // Sortar por date asc — API retorna fora de ordem (gotcha do smoke)
    const sorted = [...rawResults].sort((a, b) => a.date.localeCompare(b.date))

    const today = new Date().toISOString().slice(0, 10)
    let totalSynced = 0

    for (const day of sorted) {
      const dateKey   = day.date.slice(0, 10)
      const isPartial = dateKey === today  // último dia tem totals parciais

      // 1. Cross-join com orders pra conversion
      const { dayOrders, dayUnits } = await this.fetchOrdersTotalsForDate(orgId, sellerId, dateKey)

      const conv = day.total > 0 ? (dayOrders / day.total) * 100 : null

      // 2. Comparação com prev_day e same_day_last_week (best-effort)
      const prevDayDate = this.dateOffset(dateKey, -1)
      const lastWeekDate = this.dateOffset(dateKey, -7)
      const [prev, lw] = await Promise.all([
        this.fetchVisitsDay(orgId, sellerId, prevDayDate),
        this.fetchVisitsDay(orgId, sellerId, lastWeekDate),
      ])

      const changePrev = prev && prev.total_visits > 0
        ? ((day.total - prev.total_visits) / prev.total_visits) * 100
        : null
      const changeLw = lw && lw.total_visits > 0
        ? ((day.total - lw.total_visits) / lw.total_visits) * 100
        : null

      // 3. Upsert
      const { error } = await supabaseAdmin
        .from('ml_items_visits_daily')
        .upsert({
          organization_id: orgId,
          seller_id:       sellerId,
          date:            dateKey,
          total_visits:    day.total ?? 0,
          visits_detail:   day.visits_detail ?? [],
          is_partial:      isPartial,
          total_orders:    dayOrders,
          total_units_sold: dayUnits,
          conversion_rate_pct: conv,
          visits_change_pct_vs_prev_day:    changePrev,
          visits_change_pct_vs_same_day_lw: changeLw,
          computed_at:     new Date().toISOString(),
        }, { onConflict: 'organization_id,seller_id,date' })
      if (!error) totalSynced++
    }

    return { days_synced: totalSynced, total_visits: data.total_visits ?? 0 }
  }

  // ── Reads pra UI ─────────────────────────────────────────────────────────

  async getDailyHistory(orgId: string, sellerId: number, days = 30): Promise<Array<{
    date:                              string
    total_visits:                      number
    total_orders:                      number
    total_units_sold:                  number
    conversion_rate_pct:               number | null
    is_partial:                        boolean
    visits_change_pct_vs_prev_day:     number | null
    visits_change_pct_vs_same_day_lw:  number | null
  }>> {
    const since = this.dateOffset(new Date().toISOString().slice(0, 10), -Math.max(days, 1))
    const { data } = await supabaseAdmin
      .from('ml_items_visits_daily')
      .select('date, total_visits, total_orders, total_units_sold, conversion_rate_pct, is_partial, visits_change_pct_vs_prev_day, visits_change_pct_vs_same_day_lw')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .gte('date',           since)
      .order('date', { ascending: true })
    return (data ?? []) as Array<{
      date:                              string
      total_visits:                      number
      total_orders:                      number
      total_units_sold:                  number
      conversion_rate_pct:               number | null
      is_partial:                        boolean
      visits_change_pct_vs_prev_day:     number | null
      visits_change_pct_vs_same_day_lw:  number | null
    }>
  }

  /** Sumário 7d/30d agregado pro dashboard summary. */
  async fetchSummaryForDashboard(orgId: string, sellerId: number): Promise<{
    visits_7d:                number
    visits_7d_change_pct:     number | null
    conversion_rate_pct:      number | null
  } | null> {
    const today = new Date().toISOString().slice(0, 10)
    const since7d  = this.dateOffset(today,  -7)
    const since14d = this.dateOffset(today, -14)

    const [last7, prev7] = await Promise.all([
      this.sumWindow(orgId, sellerId, since7d, today),
      this.sumWindow(orgId, sellerId, since14d, since7d),
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

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async fetchVisitsDay(orgId: string, sellerId: number, date: string): Promise<{ total_visits: number } | null> {
    const { data } = await supabaseAdmin
      .from('ml_items_visits_daily')
      .select('total_visits')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('date',            date)
      .maybeSingle()
    return (data as { total_visits: number } | null) ?? null
  }

  private async fetchOrdersTotalsForDate(orgId: string, sellerId: number, date: string): Promise<{ dayOrders: number; dayUnits: number }> {
    const start = `${date}T00:00:00Z`
    const end   = `${date}T23:59:59.999Z`
    const { data } = await supabaseAdmin
      .from('orders')
      .select('quantity')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('platform',        'mercadolivre')
      .gte('created_at',     start)
      .lte('created_at',     end)
    const rows = (data ?? []) as Array<{ quantity: number | null }>
    const dayOrders = rows.length
    const dayUnits  = rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0)
    return { dayOrders, dayUnits }
  }

  private async sumWindow(orgId: string, sellerId: number, fromDate: string, toDateExclusive: string): Promise<{
    total_visits: number
    total_orders: number
  } | null> {
    const { data } = await supabaseAdmin
      .from('ml_items_visits_daily')
      .select('total_visits, total_orders')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .gte('date', fromDate)
      .lt('date',  toDateExclusive)
    if (!data || data.length === 0) return null
    const rows = data as Array<{ total_visits: number; total_orders: number }>
    return rows.reduce((acc, r) => ({
      total_visits: acc.total_visits + (r.total_visits ?? 0),
      total_orders: acc.total_orders + (r.total_orders ?? 0),
    }), { total_visits: 0, total_orders: 0 })
  }

  /** YYYY-MM-DD ± N dias. */
  private dateOffset(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + days)
    return d.toISOString().slice(0, 10)
  }
}
