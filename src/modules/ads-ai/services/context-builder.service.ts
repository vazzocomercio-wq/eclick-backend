import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/** Snapshot of one campaign's recent perf + the products/competitors it
 * touches. Consumed by both the insight-detector and the chat tools. */
export interface CampaignContext {
  id:           string
  name:         string | null
  status:       string | null
  daily_budget: number | null
  type:         string | null
  items:        Array<{ item_id?: string }>
  metrics_30d:  {
    days: Array<{ date: string; spend: number; revenue: number; clicks: number; impressions: number; ctr: number; roas: number; acos: number }>
    totals: { spend: number; revenue: number; clicks: number; impressions: number; conversions: number; ctr: number; roas: number; acos: number }
  }
}

@Injectable()
export class ContextBuilderService {
  private readonly logger = new Logger(ContextBuilderService.name)

  /** All campaigns + their last-30d aggregated metrics. */
  async loadCampaignsContext(orgId: string): Promise<CampaignContext[]> {
    try {
      const { data: campaigns } = await supabaseAdmin
        .from('ml_ads_campaigns')
        .select('id, name, status, daily_budget, type, items')
        .eq('organization_id', orgId)

      if (!campaigns?.length) return []

      const ids = campaigns.map(c => c.id as string)
      const dateFrom = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      const { data: reports } = await supabaseAdmin
        .from('ml_ads_reports')
        .select('campaign_id, date, clicks, impressions, spend, revenue, ctr, roas, acos, conversions')
        .eq('organization_id', orgId)
        .in('campaign_id', ids)
        .gte('date', dateFrom)
        .order('date', { ascending: true })

      const byCamp = new Map<string, Array<Record<string, unknown>>>()
      for (const r of reports ?? []) {
        const k = r.campaign_id as string
        if (!byCamp.has(k)) byCamp.set(k, [])
        byCamp.get(k)!.push(r)
      }

      return campaigns.map(c => {
        const days = byCamp.get(c.id as string) ?? []
        type Tot = { spend: number; revenue: number; clicks: number; impressions: number; conversions: number }
        const totals: Tot = days.reduce<Tot>((acc, d) => ({
          spend:       acc.spend       + Number(d.spend ?? 0),
          revenue:     acc.revenue     + Number(d.revenue ?? 0),
          clicks:      acc.clicks      + Number(d.clicks ?? 0),
          impressions: acc.impressions + Number(d.impressions ?? 0),
          conversions: acc.conversions + Number(d.conversions ?? 0),
        }), { spend: 0, revenue: 0, clicks: 0, impressions: 0, conversions: 0 })
        return {
          id:           c.id as string,
          name:         (c.name as string | null) ?? null,
          status:       (c.status as string | null) ?? null,
          daily_budget: (c.daily_budget as number | null) ?? null,
          type:         (c.type as string | null) ?? null,
          items:        Array.isArray(c.items) ? (c.items as Array<{ item_id?: string }>) : [],
          metrics_30d: {
            days: days.map(d => ({
              date:        d.date as string,
              spend:       Number(d.spend ?? 0),
              revenue:     Number(d.revenue ?? 0),
              clicks:      Number(d.clicks ?? 0),
              impressions: Number(d.impressions ?? 0),
              ctr:         Number(d.ctr ?? 0),
              roas:        Number(d.roas ?? 0),
              acos:        Number(d.acos ?? 0),
            })),
            totals: {
              ...totals,
              ctr:  totals.impressions > 0 ? totals.clicks / totals.impressions : 0,
              roas: totals.spend > 0 ? totals.revenue / totals.spend : 0,
              acos: totals.revenue > 0 ? totals.spend / totals.revenue : 0,
            },
          },
        }
      })
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[ads-ai.ctx.campaigns] ${err?.message}`)
      return []
    }
  }

  /** Stock + estimated days_of_stock for a single product, joining the
   * shared product_stock row + recent sales velocity from orders. */
  async getProductStock(orgId: string, productOrSku: string): Promise<{
    product_id: string | null; sku: string | null; name: string | null
    stock: number; reserved: number; available: number
    avg_daily_sales_30d: number; days_of_stock: number | null
  } | null> {
    try {
      const isUuid = /^[0-9a-f-]{36}$/i.test(productOrSku)
      const { data: prod } = await supabaseAdmin
        .from('products').select('id, sku, name')
        .eq(isUuid ? 'id' : 'sku', productOrSku)
        .maybeSingle()
      if (!prod) return null

      const { data: stock } = await supabaseAdmin
        .from('product_stock').select('quantity, reserved_quantity')
        .eq('product_id', prod.id).is('platform', null).maybeSingle()

      const { data: sales } = await supabaseAdmin
        .from('orders').select('quantity')
        .eq('organization_id', orgId)
        .eq('product_id', prod.id)
        .gte('sold_at', new Date(Date.now() - 30 * 86_400_000).toISOString())

      const totalSold30d = (sales ?? []).reduce((s, r) => s + Number((r as { quantity?: number }).quantity ?? 0), 0)
      const avgDaily     = totalSold30d / 30
      const qty          = Number(stock?.quantity ?? 0)
      const reserved     = Number(stock?.reserved_quantity ?? 0)
      const available    = Math.max(0, qty - reserved)
      const days         = avgDaily > 0 ? available / avgDaily : null

      return {
        product_id: prod.id as string,
        sku:        prod.sku as string | null,
        name:       prod.name as string | null,
        stock:      qty,
        reserved,
        available,
        avg_daily_sales_30d: avgDaily,
        days_of_stock: days,
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[ads-ai.ctx.stock] ${err?.message}`)
      return null
    }
  }

  async getProductMargin(orgId: string, productId: string) {
    try {
      const { data } = await supabaseAdmin
        .from('products')
        .select('id, sku, name, cost_price, tax_percentage, tax_on_freight, price')
        .eq('id', productId).maybeSingle()
      if (!data) return null
      const cost  = Number(data.cost_price ?? 0)
      const tax   = Number(data.tax_percentage ?? 0)
      const price = Number(data.price ?? 0)
      const taxAmount     = price * (tax / 100)
      const grossMargin   = price - cost - taxAmount
      const grossMarginPct = price > 0 ? (grossMargin / price) * 100 : 0
      return {
        product_id: data.id as string,
        sku:        data.sku as string | null,
        name:       data.name as string | null,
        cost_price: cost,
        tax_pct:    tax,
        price,
        tax_amount: taxAmount,
        gross_margin_brl: grossMargin,
        gross_margin_pct: grossMarginPct,
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[ads-ai.ctx.margin] ${err?.message}`)
      return null
    }
  }

  async getCompetitorPrices(orgId: string, productId: string) {
    try {
      const { data } = await supabaseAdmin
        .from('competitors')
        .select('id, title, seller, current_price, my_price, status, last_checked')
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .eq('status', 'active')
      return data ?? []
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[ads-ai.ctx.competitors] ${err?.message}`)
      return []
    }
  }

  async getRecentOrders(orgId: string, productId: string, days = 30) {
    try {
      const since = new Date(Date.now() - days * 86_400_000).toISOString()
      const { data } = await supabaseAdmin
        .from('orders')
        .select('external_order_id, sold_at, quantity, sale_price, source, status')
        .eq('organization_id', orgId)
        .eq('product_id', productId)
        .gte('sold_at', since)
        .order('sold_at', { ascending: false })
        .limit(100)
      return data ?? []
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[ads-ai.ctx.orders] ${err?.message}`)
      return []
    }
  }
}
