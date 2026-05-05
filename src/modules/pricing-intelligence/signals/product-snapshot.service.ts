import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { PricingConfigService } from '../pricing-config.service'
import { ProductSnapshot } from './types'

/** Agrega dados do produto em paralelo (sales/stock/ads/concorrentes/
 * compras/histórico/sazonal) + config da org. Cada bloco é best-effort:
 * falha de leitura não derruba snapshot — vira null e penaliza confiança.
 *
 * Para Sprint P2 v1, alguns sinais (ads/competitors) podem retornar
 * vazios se as tabelas não estão populadas. Isso é OK — gera signals
 * tipo 'low_confidence' em vez de decisões de preço. */
@Injectable()
export class ProductSnapshotService {
  private readonly logger = new Logger(ProductSnapshotService.name)

  constructor(private readonly cfg: PricingConfigService) {}

  async getSnapshot(orgId: string, productId: string): Promise<ProductSnapshot | null> {
    const config = await this.cfg.getOrCreate(orgId)

    // Promise.all paralelo — cada query é defensiva (try/catch interno)
    const [
      productRow, stockData, salesData, adsData,
      competitorsData, incomingData, historyData, seasonalData,
    ] = await Promise.all([
      this.fetchProduct(orgId, productId),
      this.fetchStock(orgId, productId),
      this.fetchSales(orgId, productId),
      this.fetchAds(orgId, productId),
      this.fetchCompetitors(orgId, productId),
      this.fetchIncoming(orgId, productId),
      this.fetchPriceHistory(orgId, productId),
      this.fetchSeasonal(orgId),
    ])

    if (!productRow) return null

    const isNewProduct = productRow.created_at
      ? (Date.now() - new Date(productRow.created_at).getTime()) < 30 * 86_400_000
      : false

    // Confidence breakdown — penaliza pela ausência de cada fonte
    const penalties = config.confidence_rules?.penalties ?? {}
    const breakdown: Record<string, number> = {}
    if (!productRow.cost_price)           breakdown.no_cost_data          = penalties.no_cost_data ?? 30
    if (salesData.d90 === 0)              breakdown.no_sales_history      = penalties.no_sales_history ?? 20
    if (competitorsData.prices.length === 0) breakdown.no_competitor_data = penalties.no_competitor_data ?? 25
    if (isNewProduct)                     breakdown.new_product_under_30d = penalties.new_product_under_30d ?? 15

    const dataAgeHours = (Date.now() - new Date(productRow.updated_at ?? productRow.created_at ?? Date.now()).getTime()) / 3_600_000
    if (dataAgeHours > 48)                breakdown.stale_data_over_48h   = penalties.stale_data_over_48h ?? 10

    const confidence_score = Math.max(0, 100 - Object.values(breakdown).reduce((s, v) => s + v, 0))

    // Coverage = quantity / velocity
    const coverage_days = stockData.quantity && stockData.velocity && stockData.velocity > 0
      ? Math.floor(stockData.quantity / stockData.velocity)
      : null

    // Seasonal adjustment ativo agora (start_date <= now <= end_date)
    const now = new Date()
    const activeSeasonal = (seasonalData ?? []).find(p => {
      const start = new Date(p.start_date + 'T00:00:00')
      const end   = new Date(p.end_date   + 'T23:59:59')
      return p.is_active && start <= now && now <= end
    }) ?? null

    return {
      product: {
        id:            productRow.id,
        name:          productRow.name ?? null,
        sku:           productRow.sku ?? null,
        listing_id:    productRow.ml_listing_id ?? productRow.listing_id ?? null,
        current_price: productRow.current_price ?? productRow.sale_price ?? null,
        cost_price:    productRow.cost_price ?? null,
      },
      abc_curve:  productRow.abc_curve ?? null,
      segment:    productRow.segment   ?? null,
      stock: {
        quantity:       stockData.quantity,
        velocity:       stockData.velocity,
        coverage_days,
      },
      sales: salesData,
      ads:        adsData,
      competitors: competitorsData,
      incoming:   incomingData,
      history:    historyData,
      seasonal: {
        period:         activeSeasonal,
        adjustment_pct: activeSeasonal?.pricing_adjustment_pct ?? null,
      },
      config_for_org: config,
      data_sources: {
        has_cost:          !!productRow.cost_price,
        has_sales_history: salesData.d90 > 0,
        has_competitor:    competitorsData.prices.length > 0,
        has_ads:           adsData.ctr_7d != null || adsData.in_active_campaign,
        has_stock:         stockData.quantity != null,
      },
      is_new_product:       isNewProduct,
      data_age_hours:       Math.round(dataAgeHours * 10) / 10,
      confidence_score,
      confidence_breakdown: breakdown,
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchProduct(orgId: string, productId: string): Promise<any> {
    try {
      const { data } = await supabaseAdmin
        .from('products').select('*')
        .eq('id', productId).eq('organization_id', orgId).maybeSingle()
      return data
    } catch (e) { this.logger.warn(`[snapshot.product] ${(e as Error).message}`); return null }
  }

  private async fetchStock(orgId: string, productId: string): Promise<{ quantity: number | null; velocity: number | null }> {
    try {
      const { data: prod } = await supabaseAdmin
        .from('products').select('stock_quantity')
        .eq('id', productId).eq('organization_id', orgId).maybeSingle()
      const quantity = (prod?.stock_quantity as number | null) ?? null

      // Velocity = sales 30d / 30
      const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const { count } = await supabaseAdmin
        .from('orders').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .gte('sold_at', cutoff30)
        .not('status', 'in', '(cancelled,refunded)')
      const velocity = count != null && count > 0 ? Math.round((count / 30) * 100) / 100 : null
      return { quantity, velocity }
    } catch (e) { this.logger.warn(`[snapshot.stock] ${(e as Error).message}`); return { quantity: null, velocity: null } }
  }

  private async fetchSales(orgId: string, productId: string): Promise<ProductSnapshot['sales']> {
    try {
      const cutoff7  = new Date(Date.now() -  7 * 86_400_000).toISOString()
      const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString()

      const [ord7, ord30, ord90, last] = await Promise.all([
        supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).eq('product_id', productId)
          .gte('sold_at', cutoff7).not('status', 'in', '(cancelled,refunded)'),
        supabaseAdmin.from('orders').select('sale_price', { count: 'exact' })
          .eq('organization_id', orgId).eq('product_id', productId)
          .gte('sold_at', cutoff30).not('status', 'in', '(cancelled,refunded)'),
        supabaseAdmin.from('orders').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).eq('product_id', productId)
          .gte('sold_at', cutoff90).not('status', 'in', '(cancelled,refunded)'),
        supabaseAdmin.from('orders').select('sold_at')
          .eq('organization_id', orgId).eq('product_id', productId)
          .not('status', 'in', '(cancelled,refunded)')
          .order('sold_at', { ascending: false }).limit(1).maybeSingle(),
      ])

      const d7  = ord7.count  ?? 0
      const d30 = ord30.count ?? 0
      const d90 = ord90.count ?? 0
      const revenue_30d = (ord30.data ?? []).reduce((s, r) => s + Number((r as { sale_price?: number }).sale_price ?? 0), 0)

      // Trend: vendas dos últimos 7d × 4.28 (semana) vs média mensal
      const weeklyAvg = d30 / 4.28
      const trend = weeklyAvg > 0 ? ((d7 - weeklyAvg) / weeklyAvg) * 100 : null

      const lastSaleAt = (last.data as { sold_at?: string } | null)?.sold_at ?? null
      const daysSince = lastSaleAt
        ? Math.floor((Date.now() - new Date(lastSaleAt).getTime()) / 86_400_000)
        : null

      return { d7, d30, d90, revenue_30d, trend_7d_vs_30d_pct: trend, last_sale_at: lastSaleAt, days_since_last_sale: daysSince }
    } catch (e) {
      this.logger.warn(`[snapshot.sales] ${(e as Error).message}`)
      return { d7: 0, d30: 0, d90: 0, revenue_30d: 0, trend_7d_vs_30d_pct: null, last_sale_at: null, days_since_last_sale: null }
    }
  }

  private async fetchAds(orgId: string, productId: string): Promise<ProductSnapshot['ads']> {
    // FIX PRC-3: antes ctr/roas/acos sempre eram null → triggers ctr_drop,
    // high_roas e active_ads (com base em performance) ficavam mortos.
    // Agora agrega ml_ads_reports últimos 7d das campaigns que contêm o
    // ml_listing_id deste produto.
    try {
      // 1. Resolve ml_listing_id do produto
      const { data: prod } = await supabaseAdmin
        .from('products').select('ml_listing_id')
        .eq('id', productId).eq('organization_id', orgId).maybeSingle()
      const listingId = (prod as { ml_listing_id?: string | null } | null)?.ml_listing_id
      if (!listingId) {
        return { ctr_7d: null, roas_7d: null, acos_7d: null, in_active_campaign: false }
      }

      // 2. Campaigns ativas da org que contêm esse listing_id em items[]
      const { data: campaignsData } = await supabaseAdmin
        .from('ml_ads_campaigns').select('id, items, is_active, status')
        .eq('organization_id', orgId)
        .eq('is_active', true)
      const campaigns = (campaignsData ?? []) as Array<{ id: string; items: unknown; is_active: boolean; status: string | null }>

      const matchingCampIds: string[] = []
      for (const c of campaigns) {
        const items = Array.isArray(c.items) ? c.items : []
        const has = items.some((it: unknown) =>
          (typeof it === 'string' && it === listingId) ||
          (typeof it === 'object' && it !== null && (it as { item_id?: string }).item_id === listingId),
        )
        if (has) matchingCampIds.push(c.id)
      }

      if (matchingCampIds.length === 0) {
        return { ctr_7d: null, roas_7d: null, acos_7d: null, in_active_campaign: false }
      }

      // 3. Reports últimos 7d agregados pra essas campaigns
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
      const { data: reportsData } = await supabaseAdmin
        .from('ml_ads_reports')
        .select('clicks, impressions, spend, revenue, conversions')
        .eq('organization_id', orgId)
        .in('campaign_id', matchingCampIds)
        .gte('date', since)

      const reports = (reportsData ?? []) as Array<{
        clicks: number | null; impressions: number | null
        spend: number | null; revenue: number | null; conversions: number | null
      }>

      let clicks = 0, impressions = 0, spend = 0, revenue = 0
      for (const r of reports) {
        clicks      += Number(r.clicks ?? 0)
        impressions += Number(r.impressions ?? 0)
        spend       += Number(r.spend ?? 0)
        revenue     += Number(r.revenue ?? 0)
      }

      const ctr_7d  = impressions > 0 ? clicks / impressions     : null
      const roas_7d = spend       > 0 ? revenue / spend          : null
      const acos_7d = revenue     > 0 ? spend   / revenue        : null

      return {
        ctr_7d,
        roas_7d,
        acos_7d,
        in_active_campaign: true,
      }
    } catch (e) {
      this.logger.warn(`[snapshot.ads] ${(e as Error).message}`)
      return { ctr_7d: null, roas_7d: null, acos_7d: null, in_active_campaign: false }
    }
  }

  private async fetchCompetitors(orgId: string, productId: string): Promise<ProductSnapshot['competitors']> {
    try {
      // Tabela competitors (módulo já existente). product_id pode ser null
      // (concorrentes globais ou via SKU). Best-effort.
      const { data } = await supabaseAdmin
        .from('competitors').select('current_price, position, status')
        .eq('organization_id', orgId).eq('product_id', productId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (data ?? []) as any[]
      const prices = rows.map(r => Number(r.current_price)).filter(p => Number.isFinite(p) && p > 0)
      const minPrice = prices.length > 0 ? Math.min(...prices) : null
      const position = rows.find(r => r.position != null)?.position ?? null
      const mainOos  = rows.some(r => r.status === 'out_of_stock')
      return { prices, min_price: minPrice, position_in_channel: position, main_competitor_oos: mainOos }
    } catch {
      return { prices: [], min_price: null, position_in_channel: null, main_competitor_oos: false }
    }
  }

  private async fetchIncoming(orgId: string, productId: string): Promise<ProductSnapshot['incoming']> {
    try {
      const { data } = await supabaseAdmin
        .from('purchase_orders').select('expected_arrival_date, items, status')
        .eq('organization_id', orgId).in('status', ['placed','in_transit'])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (data ?? []) as any[]
      let units = 0, soonestArrival: Date | null = null
      for (const po of rows) {
        const items = Array.isArray(po.items) ? po.items : []
        for (const it of items) {
          if (it.product_id === productId) {
            units += Number(it.quantity ?? 0)
            if (po.expected_arrival_date) {
              const d = new Date(po.expected_arrival_date)
              if (!soonestArrival || d < soonestArrival) soonestArrival = d
            }
          }
        }
      }
      const arrival_days = soonestArrival
        ? Math.max(0, Math.floor((soonestArrival.getTime() - Date.now()) / 86_400_000))
        : null
      return { units, arrival_days, has_incoming: units > 0 }
    } catch {
      return { units: 0, arrival_days: null, has_incoming: false }
    }
  }

  private async fetchPriceHistory(orgId: string, productId: string): Promise<ProductSnapshot['history']> {
    // FIX PRC-1: tabela price_history nunca existiu. Antes a função sempre
    // falhava silencioso retornando null → trigger 'recent_change' (do_not_touch)
    // nunca disparava. Fallback honesto: products.updated_at é proxy aceitável
    // (não é exatamente "last price change" mas captura mudanças recentes).
    //
    // TODO sprint próprio: criar tabela price_history (org, product_id,
    // old_price, new_price, changed_at) com hook em UPDATE de products
    // pra ter timestamp exato de mudança de preço.
    try {
      const { data } = await supabaseAdmin
        .from('products').select('updated_at')
        .eq('id', productId)
        .eq('organization_id', orgId)
        .maybeSingle()
      const lastChangeAt = (data as { updated_at?: string } | null)?.updated_at ?? null
      const days = lastChangeAt
        ? Math.floor((Date.now() - new Date(lastChangeAt).getTime()) / 86_400_000)
        : null
      return { last_change_at: lastChangeAt, days_since_last_change: days }
    } catch {
      return { last_change_at: null, days_since_last_change: null }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchSeasonal(orgId: string): Promise<any[]> {
    try {
      const { data } = await supabaseAdmin
        .from('pricing_seasonal_periods').select('*')
        .eq('organization_id', orgId).eq('is_active', true)
      return data ?? []
    } catch { return [] }
  }
}
