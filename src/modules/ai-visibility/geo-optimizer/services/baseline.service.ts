import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../../common/supabase'

/**
 * Captura o snapshot de métricas ANTES do apply (base do ImpactTracker / Dia 14).
 * Métricas universais (visitas/unidades/receita) vêm de tabelas já sincronizadas;
 * ads é best-effort (só listings em campanha). Perguntas/reviews ficam como
 * delta de snapshot no Dia 14 (precisam de chamada à API ML).
 */
@Injectable()
export class BaselineService {
  private readonly logger = new Logger(BaselineService.name)

  async capture(input: {
    orgId: string; listingId: string; productId?: string | null; geoScore?: number | null; token?: string
  }): Promise<Record<string, unknown>> {
    const since14 = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)

    const [visits, sales, ads] = await Promise.all([
      this.visits14d(input.orgId, input.listingId, input.token),
      this.sales14d(input.orgId, input.productId, since14),
      this.adsMetrics14d(input.orgId, input.listingId, since14),
    ])

    return {
      geo_score:    input.geoScore ?? null,
      visits_14d:   visits,
      units_14d:    sales.units,
      revenue_14d:  sales.revenue,
      conversion:   visits > 0 ? +(sales.units / visits).toFixed(4) : null,
      ads_metrics:  ads, // null quando não está em ADS
      window_days:  14,
    }
  }

  /**
   * Captura métricas de uma JANELA explícita [from..to] (base do ImpactTracker,
   * Dia 14 — o "depois" do piloto, medido no wash period D+3..D+16). Mesma forma
   * do baseline (visitas/unidades/receita/conversão), mas por intervalo de datas.
   */
  async capturePostWindow(input: {
    orgId: string; listingId: string; productId?: string | null; token?: string
    fromDate: string; toDate: string // 'YYYY-MM-DD'
  }): Promise<{ visits: number; units: number; revenue: number; conversion: number | null }> {
    const [visits, sales] = await Promise.all([
      this.visitsBetween(input.listingId, input.fromDate, input.toDate, input.token),
      this.salesBetween(input.orgId, input.productId, input.fromDate, input.toDate),
    ])
    return {
      visits,
      units:      sales.units,
      revenue:    sales.revenue,
      conversion: visits > 0 ? +(sales.units / visits).toFixed(4) : null,
    }
  }

  /** Visitas num intervalo de datas via API ML (`/visits?date_from&date_to`).
   *  Retorna 0 sem token ou em erro (ML guarda ~150d, nossa janela cabe). */
  private async visitsBetween(mlItemId: string, fromDate: string, toDate: string, token?: string): Promise<number> {
    if (!token) return 0
    try {
      const from = `${fromDate}T00:00:00.000Z`
      const to   = `${toDate}T23:59:59.999Z`
      const { data } = await axios.get(
        `https://api.mercadolibre.com/items/${mlItemId}/visits?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
      )
      const total = Number((data as { total_visits?: number }).total_visits)
      return Number.isFinite(total) ? total : 0
    } catch { return 0 }
  }

  /** Unidades/receita de product_sales_snapshots entre duas datas (inclusive). */
  private async salesBetween(orgId: string, productId: string | null | undefined, fromDate: string, toDate: string): Promise<{ units: number; revenue: number }> {
    if (!productId) return { units: 0, revenue: 0 }
    try {
      const { data } = await supabaseAdmin
        .from('product_sales_snapshots')
        .select('units_sold, revenue')
        .eq('organization_id', orgId).eq('product_id', productId)
        .gte('snapshot_date', fromDate).lte('snapshot_date', toDate)
      const rows = Array.isArray(data) ? data as Array<{ units_sold?: number; revenue?: number }> : []
      return {
        units:   rows.reduce((s, r) => s + (Number(r.units_sold) || 0), 0),
        revenue: +rows.reduce((s, r) => s + (Number(r.revenue) || 0), 0).toFixed(2),
      }
    } catch { return { units: 0, revenue: 0 } }
  }

  /** Visitas 14d: preferir API ML ao vivo (a tabela ml_item_visits_period é
   *  esparsa); cai pra tabela se não houver token. */
  private async visits14d(orgId: string, mlItemId: string, token?: string): Promise<number> {
    if (token) {
      try {
        const { data } = await axios.get(
          `https://api.mercadolibre.com/items/${mlItemId}/visits/time_window?last=14&unit=day`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
        )
        const live = Number((data as { total_visits?: number }).total_visits)
        if (Number.isFinite(live)) return live
      } catch { /* cai pra tabela */ }
    }
    try {
      const { data } = await supabaseAdmin
        .from('ml_item_visits_period')
        .select('total_visits, period_end')
        .eq('organization_id', orgId).eq('ml_item_id', mlItemId)
        .order('period_end', { ascending: false }).limit(1).maybeSingle()
      return Number((data as { total_visits?: number } | null)?.total_visits ?? 0) || 0
    } catch { return 0 }
  }

  private async sales14d(orgId: string, productId: string | null | undefined, since: string): Promise<{ units: number; revenue: number }> {
    if (!productId) return { units: 0, revenue: 0 }
    try {
      const { data } = await supabaseAdmin
        .from('product_sales_snapshots')
        .select('units_sold, revenue')
        .eq('organization_id', orgId).eq('product_id', productId).gte('snapshot_date', since)
      const rows = Array.isArray(data) ? data as Array<{ units_sold?: number; revenue?: number }> : []
      return {
        units:   rows.reduce((s, r) => s + (Number(r.units_sold) || 0), 0),
        revenue: +rows.reduce((s, r) => s + (Number(r.revenue) || 0), 0).toFixed(2),
      }
    } catch { return { units: 0, revenue: 0 } }
  }

  /** Best-effort: só retorna se o item estiver em alguma campanha de ADS. */
  private async adsMetrics14d(orgId: string, mlItemId: string, since: string): Promise<Record<string, number> | null> {
    try {
      const { data: camps } = await supabaseAdmin
        .from('ml_ads_campaigns')
        .select('id')
        .eq('organization_id', orgId)
        .filter('items::text', 'ilike', `%${mlItemId}%`)
      const ids = (camps as Array<{ id: string }> | null ?? []).map(c => c.id)
      if (ids.length === 0) return null
      const { data: reps } = await supabaseAdmin
        .from('ml_ads_reports')
        .select('impressions, clicks')
        .in('campaign_id', ids).gte('date', since)
      const rows = Array.isArray(reps) ? reps as Array<{ impressions?: number; clicks?: number }> : []
      if (rows.length === 0) return null
      return {
        impressions: rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0),
        clicks:      rows.reduce((s, r) => s + (Number(r.clicks) || 0), 0),
      }
    } catch { return null }
  }
}
