import { Injectable, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

type Tendencia = 'POSITIVA' | 'ESTAVEL' | 'NEGATIVA'

const DEFAULT_LEAD = { nacional: 15, importado: 90 } as const
const DEFAULT_SAFETY = 7

function calcTendencia(s7: number, s30: number): Tendencia {
  const d7 = s7 / 7, d30 = s30 / 30
  if (d30 === 0) return 'ESTAVEL'
  if (d7 > d30 * 1.1) return 'POSITIVA'
  if (d7 < d30 * 0.9) return 'NEGATIVA'
  return 'ESTAVEL'
}

function calcPrevisao(s7: number, s30: number, s90: number, t: Tendencia): number {
  const d7 = s7 / 7, d30 = s30 / 30, d90 = s90 / 90
  const base = Math.max(d7 * 0.4 + d30 * 0.4 + d90 * 0.2, d30)
  return base * (t === 'POSITIVA' ? 1.15 : t === 'NEGATIVA' ? 0.85 : 1)
}

function calcScore(
  days_of_stock: number, cobertura: number, avg_daily: number,
  t: Tendencia, margin_pct: number, supply_type: string,
): number {
  const esc  = Math.min(100, Math.max(0, (1 - days_of_stock / Math.max(cobertura, 1)) * 100))
  const giro = Math.min(100, (avg_daily / 5) * 100)
  const tend = t === 'POSITIVA' ? 80 : t === 'NEGATIVA' ? 20 : 50
  const marg = Math.min(100, Math.max(0, margin_pct * 5))
  const lead = supply_type === 'importado' ? 80 : 40
  return esc * 0.25 + (giro * 0.5 + tend * 0.5) * 0.25 + marg * 0.20 + lead * 0.15 + 50 * 0.10 + 50 * 0.05
}

function getClassif(s: number): { classificacao: string; acao: string } {
  if (s >= 85) return { classificacao: 'CRITICO', acao: '🚨 Comprar urgente' }
  if (s >= 70) return { classificacao: 'ALTO',    acao: '🔴 Comprar' }
  if (s >= 50) return { classificacao: 'MEDIO',   acao: '🟡 Monitorar' }
  if (s >= 30) return { classificacao: 'BAIXO',   acao: '⚪ Reduzir compra' }
  return            { classificacao: 'RUIM',    acao: '❌ Não comprar' }
}

type SalesEntry = { s7: number; s30: number; s90: number; margins: number[] }
type SupEntry   = { lead: number; safety: number; type: string; name: string }

@Injectable()
export class ComprasService {

  private async fetchRawData(orgId: string) {
    const now    = Date.now()
    const since90 = new Date(now - 90 * 86400000).toISOString()
    const since30 = new Date(now - 30 * 86400000).toISOString()
    const since7  = new Date(now - 7  * 86400000).toISOString()

    const { data: products, error: pErr } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, cost_price, photo_urls, supply_type, abc_class')
      .eq('organization_id', orgId)
    if (pErr) throw new HttpException(pErr.message, 500)

    const productIds = (products ?? []).map(p => p.id)
    if (productIds.length === 0) {
      return { products: [], salesMap: new Map<string, SalesEntry>(), stockMap: new Map<string, number>(), supplierMap: new Map<string, SupEntry>() }
    }

    const [ordersRes, stockRes, supRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('product_id, quantity, sold_at, contribution_margin_pct')
        .eq('organization_id', orgId)
        .gte('sold_at', since90)
        .in('product_id', productIds),
      supabaseAdmin
        .from('product_stock')
        .select('product_id, quantity')
        .in('product_id', productIds),
      supabaseAdmin
        .from('supplier_products')
        .select('product_id, lead_time_days, safety_days, suppliers(name, supplier_type)')
        .eq('is_preferred', true)
        .in('product_id', productIds),
    ])

    // Sales map
    const salesMap = new Map<string, SalesEntry>()
    for (const o of ordersRes.data ?? []) {
      if (!o.product_id) continue
      const e = salesMap.get(o.product_id) ?? { s7: 0, s30: 0, s90: 0, margins: [] }
      const qty = Number(o.quantity ?? 0)
      e.s90 += qty
      if ((o.sold_at as string) >= since30) e.s30 += qty
      if ((o.sold_at as string) >= since7)  e.s7  += qty
      const mp = Number(o.contribution_margin_pct)
      if (!isNaN(mp) && mp !== 0) e.margins.push(mp)
      salesMap.set(o.product_id, e)
    }

    // Stock map (SUM per product in case of multiple rows)
    const stockMap = new Map<string, number>()
    for (const s of stockRes.data ?? []) {
      if (!s.product_id) continue
      stockMap.set(s.product_id, (stockMap.get(s.product_id) ?? 0) + Number(s.quantity ?? 0))
    }

    // Supplier map
    const supplierMap = new Map<string, SupEntry>()
    for (const sp of supRes.data ?? []) {
      if (!sp.product_id) continue
      const supRaw = (sp as unknown as { suppliers: { name: string; supplier_type: string } | { name: string; supplier_type: string }[] | null }).suppliers
      const sup = Array.isArray(supRaw) ? supRaw[0] ?? null : supRaw
      supplierMap.set(sp.product_id, {
        lead:   sp.lead_time_days  ?? DEFAULT_LEAD.nacional,
        safety: sp.safety_days     ?? DEFAULT_SAFETY,
        type:   sup?.supplier_type ?? 'nacional',
        name:   sup?.name          ?? '',
      })
    }

    return { products: products ?? [], salesMap, stockMap, supplierMap }
  }

  async getInteligencia(orgId: string, filters: {
    periodo?: number; supply_type?: string; abc_class?: string; min_score?: number; q?: string
  }) {
    const { products, salesMap, stockMap, supplierMap } = await this.fetchRawData(orgId)

    const result = products.map(p => {
      const s    = salesMap.get(p.id)   ?? { s7: 0, s30: 0, s90: 0, margins: [] }
      const stock = stockMap.get(p.id)  ?? 0
      const sup  = supplierMap.get(p.id)

      const supply_type = (p as { supply_type?: string }).supply_type ?? sup?.type ?? 'nacional'
      const lead_time   = sup?.lead   ?? (DEFAULT_LEAD[supply_type as 'nacional' | 'importado'] ?? DEFAULT_LEAD.nacional)
      const safety      = sup?.safety ?? DEFAULT_SAFETY

      const avg_daily  = s.s30 / 30
      const days_stock = avg_daily > 0 ? Math.round(stock / avg_daily) : 999
      const tend       = calcTendencia(s.s7, s.s30)
      const prev       = calcPrevisao(s.s7, s.s30, s.s90, tend)
      const cobertura  = supply_type === 'importado' ? lead_time * 1.5 : lead_time * 1.1
      const est_ideal  = prev * cobertura
      const sugestao   = Math.max(0, est_ideal - stock)
      const margin_pct = s.margins.length > 0
        ? s.margins.reduce((a, b) => a + b, 0) / s.margins.length
        : 0
      const scoreVal   = calcScore(days_stock, cobertura, avg_daily, tend, margin_pct, supply_type)

      return {
        id:                  p.id,
        name:                p.name as string,
        sku:                 (p.sku as string | null) ?? '',
        cost_price:          Number(p.cost_price ?? 0),
        photo_url:           ((p as { photo_urls?: string[] }).photo_urls ?? [])[0] ?? null,
        supply_type,
        abc_class:           (p as { abc_class?: string }).abc_class ?? null as string | null,
        current_stock:       stock,
        virtual_stock:       0,
        in_transit:          0,
        sales_7d:            s.s7,
        sales_30d:           s.s30,
        sales_90d:           s.s90,
        avg_daily_sales_30d: parseFloat(avg_daily.toFixed(2)),
        days_of_stock:       days_stock,
        lead_time_days:      lead_time,
        safety_days:         safety,
        tendencia:           tend,
        previsao_diaria:     parseFloat(prev.toFixed(2)),
        cobertura_necessaria: parseFloat(cobertura.toFixed(1)),
        estoque_ideal:       Math.round(est_ideal),
        sugestao_compra:     Math.round(sugestao),
        margin_pct:          parseFloat(margin_pct.toFixed(1)),
        score:               parseFloat(scoreVal.toFixed(1)),
        ...getClassif(Math.round(scoreVal)),
        supplier_name:       sup?.name ?? null,
      }
    })

    // Compute ABC class from revenue if not stored on products
    if (result.every(p => !p.abc_class)) {
      const sorted = [...result].sort((a, b) => b.sales_90d * b.cost_price - a.sales_90d * a.cost_price)
      const n = sorted.length
      sorted.forEach((p, i) => {
        const pct = (i + 1) / n
        p.abc_class = pct <= 0.2 ? 'A' : pct <= 0.5 ? 'B' : 'C'
      })
    }

    // Filters
    let out = result
    if (filters.supply_type) out = out.filter(p => p.supply_type === filters.supply_type)
    if (filters.abc_class)   out = out.filter(p => p.abc_class   === filters.abc_class)
    if (filters.min_score)   out = out.filter(p => p.score       >= (filters.min_score ?? 0))
    if (filters.q) {
      const q = filters.q.toLowerCase()
      out = out.filter(p => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
    }

    return out.sort((a, b) => b.score - a.score)
  }

  async getSummary(orgId: string) {
    const items  = await this.getInteligencia(orgId, {})
    const active = items.filter(p => p.avg_daily_sales_30d > 0)
    return {
      capital_sugerido:      items.filter(p => p.score >= 50).reduce((s, p) => s + p.sugestao_compra * p.cost_price, 0),
      produtos_criticos:     items.filter(p => p.score >= 85).length,
      produtos_parados:      items.filter(p => p.days_of_stock > 180 && p.avg_daily_sales_30d < 0.1).length,
      produtos_oportunidade: items.filter(p => p.tendencia === 'POSITIVA' && p.score >= 50).length,
      importacoes_urgentes:  items.filter(p => p.supply_type === 'importado' && p.score >= 70).length,
      cobertura_media:       active.length > 0
        ? parseFloat((active.reduce((s, p) => s + Math.min(p.days_of_stock, 365), 0) / active.length).toFixed(1))
        : 0,
    }
  }
}
