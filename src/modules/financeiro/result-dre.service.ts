import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { OperatingCostsService } from './operating-costs.service'

/**
 * Motor de DRE viva (Central de Resultado) — Fase 2.
 *
 * Junta o que o SaaS já tem, por período (mês):
 *   Receita (orders) − Custo variável (já em orders.contribution_margin)
 *   = Margem de contribuição
 *   − ADS (ml_ads_reports; atribuído por SKU via campanha→itens→products)
 *   − Custo fixo rateado (operating_costs; por participação na MC)
 *   = Lucro líquido (R$ e %)
 * + TACOS (ADS ÷ receita TOTAL, incl. orgânica) + governador de carteira
 *   (envelope de ADS que ainda bate a meta consolidada).
 *
 * Fonte da margem: orders.contribution_margin (R$) — já calculado pelo motor de
 * margem (Preço−Tarifa−Frete−Custo−Imposto), inclui vendas orgânicas. Exclui cancelled.
 * ADS = ML (ml_ads_reports) — domínio do e-commerce ML; Meta/Google entram no
 * consolidado numa refino futuro.
 */
@Injectable()
export class ResultDreService {
  private readonly logger = new Logger('ResultDreService')

  constructor(private readonly opCosts: OperatingCostsService) {}

  // ── Consolidado (org/mês) ────────────────────────────────────────────────

  async getConsolidated(orgId: string, month?: string) {
    const ym = month ?? new Date().toISOString().slice(0, 7)
    const { start, endExcl } = monthRange(ym)

    const orders = await this.fetchOrders(orgId, start, endExcl)
    let revenue = 0, cm = 0, units = 0
    for (const o of orders) {
      revenue += num(o.sale_price) * num(o.quantity)
      cm += num(o.contribution_margin)
      units += num(o.quantity)
    }
    const adSpend = await this.mlAdSpendTotal(orgId, ym)
    const fixed = (await this.opCosts.getMonthlyTotal(orgId, ym)).total
    const { target_net_margin_pct: target } = await this.opCosts.getResultConfig(orgId)

    const net = r2(cm - adSpend - fixed)
    const pct = (n: number) => (revenue > 0 ? r2((n / revenue) * 100) : null)
    // envelope de ADS que ainda entrega a meta consolidada
    const adEnvelope = r2(cm - fixed - (target / 100) * revenue)

    return {
      month: ym,
      revenue: r2(revenue),
      variable_cost: r2(revenue - cm),
      contribution_margin: r2(cm),
      contribution_margin_pct: pct(cm),
      ad_spend: r2(adSpend),
      tacos_pct: pct(adSpend),
      fixed_cost: r2(fixed),
      net_profit: net,
      net_margin_pct: pct(net),
      target_net_margin_pct: target,
      gap_pct: pct(net) != null ? r2((pct(net) as number) - target) : null,
      ad_budget_envelope: adEnvelope, // ADS máx p/ bater a meta; negativo = já estourou
      ad_envelope_remaining: r2(adEnvelope - adSpend), // quanto ainda cabe de ADS
      units,
      orders: orders.length,
    }
  }

  // ── Por SKU/anúncio (org/mês) ────────────────────────────────────────────

  async getByProduct(orgId: string, month?: string, limit = 200) {
    const ym = month ?? new Date().toISOString().slice(0, 7)
    const { start, endExcl } = monthRange(ym)

    const orders = await this.fetchOrders(orgId, start, endExcl)
    interface Agg { product_id: string; name: string; sku: string | null; revenue: number; cm: number; units: number }
    const byProd = new Map<string, Agg>()
    for (const o of orders) {
      const pid = o.product_id
      if (!pid) continue
      const a = byProd.get(pid) ?? { product_id: pid, name: o.product_title ?? '(sem nome)', sku: o.sku ?? null, revenue: 0, cm: 0, units: 0 }
      a.revenue += num(o.sale_price) * num(o.quantity)
      a.cm += num(o.contribution_margin)
      a.units += num(o.quantity)
      byProd.set(pid, a)
    }

    const adByProduct = await this.mlAdSpendByProduct(orgId, ym)
    const fixed = (await this.opCosts.getMonthlyTotal(orgId, ym)).total
    // rateio do fixo por participação na MC POSITIVA (quem perde não recebe fixo)
    const totalPosCm = [...byProd.values()].reduce((s, a) => s + Math.max(0, a.cm), 0)

    const rows = [...byProd.values()].map((a) => {
      const fixedAlloc = totalPosCm > 0 && a.cm > 0 ? fixed * (a.cm / totalPosCm) : 0
      const adSpend = adByProduct.get(a.product_id) ?? 0
      const net = a.cm - adSpend - fixedAlloc
      const pct = (n: number) => (a.revenue > 0 ? r2((n / a.revenue) * 100) : null)
      return {
        product_id: a.product_id,
        name: a.name,
        sku: a.sku,
        units: a.units,
        revenue: r2(a.revenue),
        contribution_margin: r2(a.cm),
        contribution_margin_pct: pct(a.cm),
        ad_spend: r2(adSpend),
        acos_pct: a.revenue > 0 && adSpend > 0 ? r2((adSpend / a.revenue) * 100) : null,
        fixed_cost_allocated: r2(fixedAlloc),
        net_profit: r2(net),
        net_margin_pct: pct(net),
      }
    })
    // pior líquido primeiro (onde está sangrando)
    rows.sort((x, y) => x.net_profit - y.net_profit)
    return { month: ym, count: rows.length, products: rows.slice(0, limit) }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Pedidos não-cancelados do período (paginado). */
  private async fetchOrders(orgId: string, startIso: string, endExclIso: string) {
    const out: Array<{ product_id: string | null; product_title: string | null; sku: string | null; quantity: number; sale_price: number; contribution_margin: number }> = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('orders')
        .select('product_id, product_title, sku, quantity, sale_price, contribution_margin')
        .eq('organization_id', orgId)
        .neq('status', 'cancelled')
        .gte('sold_at', startIso)
        .lt('sold_at', endExclIso)
        .range(from, from + PAGE - 1)
      if (error) { this.logger.warn(`fetchOrders: ${error.message}`); break }
      const rows = (data ?? []) as typeof out
      out.push(...rows)
      if (rows.length < PAGE) break
    }
    return out
  }

  private async mlAdSpendTotal(orgId: string, ym: string): Promise<number> {
    const { start, endExcl } = monthRange(ym)
    const { data, error } = await supabaseAdmin
      .from('ml_ads_reports')
      .select('spend')
      .eq('organization_id', orgId)
      .gte('date', start.slice(0, 10))
      .lt('date', endExcl.slice(0, 10))
    if (error) { this.logger.warn(`mlAdSpendTotal: ${error.message}`); return 0 }
    return r2((data ?? []).reduce((s, r) => s + num((r as { spend: number }).spend), 0))
  }

  /** Atribui o gasto de ADS do ML por SKU: spend da campanha ÷ nº de itens →
   *  item(MLB) → products.ml_listing_id → product_id. */
  private async mlAdSpendByProduct(orgId: string, ym: string): Promise<Map<string, number>> {
    const map = new Map<string, number>()
    const { start, endExcl } = monthRange(ym)

    const [campsRes, repsRes, prodsRes] = await Promise.all([
      supabaseAdmin.from('ml_ads_campaigns').select('id, items').eq('organization_id', orgId),
      supabaseAdmin.from('ml_ads_reports').select('campaign_id, spend').eq('organization_id', orgId).gte('date', start.slice(0, 10)).lt('date', endExcl.slice(0, 10)),
      supabaseAdmin.from('products').select('id, ml_listing_id').eq('organization_id', orgId).not('ml_listing_id', 'is', null),
    ])
    if (campsRes.error || repsRes.error || prodsRes.error) {
      this.logger.warn(`mlAdSpendByProduct: ${campsRes.error?.message ?? repsRes.error?.message ?? prodsRes.error?.message}`)
      return map
    }
    // spend por campanha
    const spendByCamp = new Map<string, number>()
    for (const r of (repsRes.data ?? []) as Array<{ campaign_id: string; spend: number }>) {
      spendByCamp.set(r.campaign_id, (spendByCamp.get(r.campaign_id) ?? 0) + num(r.spend))
    }
    // mlb → product_id
    const prodByMlb = new Map<string, string>()
    for (const p of (prodsRes.data ?? []) as Array<{ id: string; ml_listing_id: string }>) {
      prodByMlb.set(p.ml_listing_id, p.id)
    }
    // rateia spend da campanha igualmente entre seus itens, mapeia pro produto
    for (const c of (campsRes.data ?? []) as Array<{ id: string; items: unknown }>) {
      const spend = spendByCamp.get(c.id) ?? 0
      if (spend <= 0) continue
      const itemsRaw = Array.isArray(c.items) ? c.items : []
      const mlbs = itemsRaw
        .map((i) => (typeof i === 'string' ? i : (i as { item_id?: string })?.item_id))
        .filter((x): x is string => !!x)
      if (mlbs.length === 0) continue
      const per = spend / mlbs.length
      for (const mlb of mlbs) {
        const pid = prodByMlb.get(mlb)
        if (pid) map.set(pid, (map.get(pid) ?? 0) + per)
      }
    }
    return map
  }
}

function monthRange(ym: string): { start: string; endExcl: string } {
  const [y, m] = ym.split('-').map(Number)
  const start = new Date(Date.UTC(y, m - 1, 1)).toISOString()
  const endExcl = new Date(Date.UTC(y, m, 1)).toISOString()
  return { start, endExcl }
}
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function r2(n: number): number {
  return Math.round(n * 100) / 100
}
