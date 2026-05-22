import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * AI — Analytics da Vitrine (Loja Própria).
 *
 * Monta o funil de conversão + insights combinando:
 *   - storefront_events  (visitas, views de produto, add_to_cart, checkout)
 *   - storefront_orders  (pedidos iniciados, pagos, receita, top vendidos)
 *   - whatsapp_carts     (abandono/recuperação — best-effort)
 *
 * Agregação em JS com paginação (evita o teto de 1000 linhas do PostgREST).
 * Suficiente pra lojas SMB; se o volume crescer, migra pra função SQL.
 */

const PAGE = 1000
const MAX_PAGES = 60  // teto de segurança (60k linhas por consulta)

interface EventRow { session_id: string; event_type: string; product_id: string | null; source: string | null }
interface OrderRow { status: string; total: number | string | null; items: unknown; created_at: string }

@Injectable()
export class StorefrontAnalyticsService {
  private readonly logger = new Logger(StorefrontAnalyticsService.name)

  private async fetchAll<T>(table: string, columns: string, orgId: string, sinceIso: string): Promise<T[]> {
    const out: T[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select(columns)
        .eq('organization_id', orgId)
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .range(page * PAGE, page * PAGE + PAGE - 1)
      if (error) { this.logger.warn(`[analytics] ${table}: ${error.message}`); break }
      const rows = (data ?? []) as T[]
      out.push(...rows)
      if (rows.length < PAGE) break
    }
    return out
  }

  async overview(orgId: string, days: number): Promise<Overview> {
    const d = clampInt(days, 1, 365)
    const since = new Date(Date.now() - d * 86_400_000)
    const sinceIso = since.toISOString()

    const [events, orders] = await Promise.all([
      this.fetchAll<EventRow>('storefront_events', 'session_id, event_type, product_id, source, created_at', orgId, sinceIso),
      this.fetchAll<OrderRow>('storefront_orders', 'status, total, items, created_at', orgId, sinceIso),
    ])

    // ── Funil baseado em sessões (eventos) ──
    const sessions = new Set<string>()
    const viewSessions = new Set<string>()
    const cartSessions = new Set<string>()
    const checkoutSessions = new Set<string>()
    const productViews = new Map<string, number>()      // productId → views
    const sourceSessions = new Map<string, Set<string>>()
    const dayVisits = new Map<string, Set<string>>()     // 'YYYY-MM-DD' → sessions

    for (const e of events) {
      sessions.add(e.session_id)
      if (e.event_type === 'product_view') {
        viewSessions.add(e.session_id)
        if (e.product_id) productViews.set(e.product_id, (productViews.get(e.product_id) ?? 0) + 1)
      } else if (e.event_type === 'add_to_cart') {
        cartSessions.add(e.session_id)
      } else if (e.event_type === 'begin_checkout') {
        checkoutSessions.add(e.session_id)
      }
      const src = (e.source ?? '').trim() || 'direto'
      if (!sourceSessions.has(src)) sourceSessions.set(src, new Set())
      sourceSessions.get(src)!.add(e.session_id)
    }
    // visitas diárias (qualquer evento) — para a tendência
    for (const e of events) {
      const day = dayKeyFromRow(e as unknown as { created_at: string })
      if (!day) continue
      if (!dayVisits.has(day)) dayVisits.set(day, new Set())
      dayVisits.get(day)!.add(e.session_id)
    }

    // ── Pedidos / receita / top vendidos ──
    const PAID = new Set(['paid'])
    let ordersCount = 0, paidCount = 0, paidRevenue = 0
    const sold = new Map<string, { qty: number; revenue: number; name: string }>()
    const dayOrders = new Map<string, number>()
    const dayRevenue = new Map<string, number>()
    for (const o of orders) {
      ordersCount++
      const day = dayKeyFromRow(o)
      if (day) dayOrders.set(day, (dayOrders.get(day) ?? 0) + 1)
      if (PAID.has(o.status)) {
        paidCount++
        const total = Number(o.total ?? 0)
        paidRevenue += total
        if (day) dayRevenue.set(day, (dayRevenue.get(day) ?? 0) + total)
        for (const it of asItems(o.items)) {
          const cur = sold.get(it.productId) ?? { qty: 0, revenue: 0, name: it.name }
          cur.qty += it.qty
          cur.revenue += it.price * it.qty
          if (!cur.name && it.name) cur.name = it.name
          sold.set(it.productId, cur)
        }
      }
    }

    // ── Nomes dos produtos (top viewed ∪ top sold) ──
    const topViewedIds = topN(productViews, 8).map(([id]) => id)
    const topSoldIds = [...sold.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 8).map(([id]) => id)
    const names = await this.productNames(orgId, [...new Set([...topViewedIds, ...topSoldIds])])

    const topViewed = topN(productViews, 8).map(([id, views]) => ({ productId: id, name: names.get(id) ?? '—', views }))
    const topSold = [...sold.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 8)
      .map(([id, v]) => ({ productId: id, name: names.get(id) ?? v.name ?? '—', qty: v.qty, revenue: round2(v.revenue) }))

    // ── Origem do tráfego ──
    const srcArr = [...sourceSessions.entries()].map(([source, set]) => ({ source, sessions: set.size }))
      .sort((a, b) => b.sessions - a.sessions).slice(0, 8)

    // ── Tendência diária ──
    const trend: TrendPoint[] = []
    for (let i = d - 1; i >= 0; i--) {
      const day = dayKey(new Date(Date.now() - i * 86_400_000))
      trend.push({
        date:    day,
        visits:  dayVisits.get(day)?.size ?? 0,
        orders:  dayOrders.get(day) ?? 0,
        revenue: round2(dayRevenue.get(day) ?? 0),
      })
    }

    // ── Carrinhos (best-effort) ──
    const carts = await this.cartStats(orgId, sinceIso)

    const visits = sessions.size
    const funnel = {
      visits,
      productViews:  viewSessions.size,
      addToCart:     cartSessions.size,
      beginCheckout: checkoutSessions.size,
      orders:        ordersCount,
      paid:          paidCount,
    }
    return {
      rangeDays: d,
      funnel,
      conversion: {
        viewRate:     pct(funnel.productViews, funnel.visits),
        cartRate:     pct(funnel.addToCart, funnel.productViews),
        checkoutRate: pct(funnel.beginCheckout, funnel.addToCart),
        paidRate:     pct(funnel.paid, funnel.orders),
        overall:      pct(funnel.paid, funnel.visits),
      },
      revenue: { paidRevenue: round2(paidRevenue), paidCount, ordersCount, aov: paidCount ? round2(paidRevenue / paidCount) : 0 },
      topViewed,
      topSold,
      sources: srcArr,
      trend,
      carts,
    }
  }

  private async productNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>()
    if (!ids.length) return m
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name')
      .eq('organization_id', orgId)
      .in('id', ids)
    for (const r of (data ?? []) as Array<{ id: string; name: string }>) m.set(r.id, r.name)
    return m
  }

  private async cartStats(orgId: string, sinceIso: string): Promise<{ abandoned: number; recovered: number; recoveryRate: number }> {
    try {
      const { data } = await supabaseAdmin
        .from('whatsapp_carts')
        .select('status')
        .eq('organization_id', orgId)
        .gte('created_at', sinceIso)
      const rows = (data ?? []) as Array<{ status: string }>
      const abandoned = rows.length
      const recovered = rows.filter(r => r.status === 'recovered').length
      return { abandoned, recovered, recoveryRate: pct(recovered, abandoned) }
    } catch {
      return { abandoned: 0, recovered: 0, recoveryRate: 0 }
    }
  }
}

interface TrendPoint { date: string; visits: number; orders: number; revenue: number }
export interface Overview {
  rangeDays: number
  funnel:    { visits: number; productViews: number; addToCart: number; beginCheckout: number; orders: number; paid: number }
  conversion: { viewRate: number; cartRate: number; checkoutRate: number; paidRate: number; overall: number }
  revenue:   { paidRevenue: number; paidCount: number; ordersCount: number; aov: number }
  topViewed: Array<{ productId: string; name: string; views: number }>
  topSold:   Array<{ productId: string; name: string; qty: number; revenue: number }>
  sources:   Array<{ source: string; sessions: number }>
  trend:     TrendPoint[]
  carts:     { abandoned: number; recovered: number; recoveryRate: number }
}

// ── helpers ──
function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}
function pct(a: number, b: number): number { return b > 0 ? round2((a / b) * 100) : 0 }
function round2(n: number): number { return Math.round(n * 100) / 100 }
function dayKey(dt: Date): string { return dt.toISOString().slice(0, 10) }
function dayKeyFromRow(r: { created_at: string }): string | null {
  try { return new Date(r.created_at).toISOString().slice(0, 10) } catch { return null }
}
function topN(m: Map<string, number>, n: number): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}
function asItems(items: unknown): Array<{ productId: string; name: string; price: number; qty: number }> {
  if (!Array.isArray(items)) return []
  return items
    .map(it => {
      const o = (it ?? {}) as Record<string, unknown>
      const productId = typeof o.productId === 'string' ? o.productId : ''
      if (!productId) return null
      return {
        productId,
        name:  typeof o.name === 'string' ? o.name : '',
        price: Number(o.price ?? 0) || 0,
        qty:   Number(o.qty ?? 0) || 0,
      }
    })
    .filter((x): x is { productId: string; name: string; price: number; qty: number } => x !== null)
}
