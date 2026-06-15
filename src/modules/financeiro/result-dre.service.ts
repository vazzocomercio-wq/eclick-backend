import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { OperatingCostsService } from './operating-costs.service'

/**
 * Motor de DRE viva (Central de Resultado) — Fase 2.4.
 *
 * Cascata (mês civil):
 *   Receita (orders)
 *   − CMV (orders.cost_price — onde cadastrado)
 *   − Taxas de plataforma REAIS (platform_charges, exceto ads)   ← fatura ML + escrow Shopee
 *   = Margem de contribuição
 *   − ADS (platform_charges categoria 'ads' — real billed; marketing)
 *   − Custo fixo rateado (operating_costs)
 *   = Lucro líquido (R$ e %)
 *
 * As taxas de plataforma deixaram de vir do estimado por pedido
 * (orders.platform_fee/shipping_cost, que erravam ~R$6k/mês e eram cegos a
 * comissão Shopee + parcelamento/cobrança ML) e passaram a vir do LEDGER REAL
 * (platform_charges). ADS idem (ml_ads_reports subestimava ~4×).
 *
 * ⚠️ CMV ainda depende de custo cadastrado (cobertura parcial) → cmv_coverage_pct
 *    expõe o gap. ⚠️ Shopee só tem taxa em pedido ENTREGUE (escrow pós-entrega)
 *    → mês corrente fica parcial e converge.
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
    let revenue = 0, cmvKnown = 0, tax = 0, units = 0, revenueWithCost = 0
    for (const o of orders) {
      const lineRev = lineRevenue(o.source, o.sale_price, o.quantity)
      revenue += lineRev
      tax += num(o.tax_amount)
      units += num(o.quantity)
      if (o.cost_price != null) { cmvKnown += num(o.cost_price); revenueWithCost += lineRev }
    }
    // CMV imputado: aplica a razão de custo dos pedidos COM custo cadastrado à
    // receita SEM custo — evita inflar o lucro tratando custo faltante como zero.
    const costRatio = revenueWithCost > 0 ? cmvKnown / revenueWithCost : 0
    const cmvImputed = r2((revenue - revenueWithCost) * costRatio)
    const cmv = r2(cmvKnown + cmvImputed)

    const charges = await this.fetchCharges(orgId, ym)
    let adSpend = 0, fees = 0
    const byCategory: Record<string, number> = {}
    for (const c of charges) {
      const signed = c.detail_type === 'credit' ? -c.amount : c.amount
      byCategory[c.charge_category] = r2((byCategory[c.charge_category] ?? 0) + signed)
      if (c.charge_category === 'ads') adSpend += signed
      else fees += signed
    }
    adSpend = r2(adSpend); fees = r2(fees)

    const fixed = (await this.opCosts.getMonthlyTotal(orgId, ym)).total
    const { target_net_margin_pct: target } = await this.opCosts.getResultConfig(orgId)

    const cm = r2(revenue - cmv - tax - fees)
    const net = r2(cm - adSpend - fixed)
    const pct = (n: number) => (revenue > 0 ? r2((n / revenue) * 100) : null)
    const adEnvelope = r2(cm - fixed - (target / 100) * revenue)

    return {
      month: ym,
      revenue: r2(revenue),
      cmv: cmv,
      cmv_imputed: cmvImputed,
      cmv_coverage_pct: revenue > 0 ? r2((revenueWithCost / revenue) * 100) : null,
      tax: r2(tax),
      platform_fees: fees,
      variable_cost: r2(cmv + tax + fees),
      contribution_margin: cm,
      contribution_margin_pct: pct(cm),
      ad_spend: adSpend,
      tacos_pct: pct(adSpend),
      fixed_cost: r2(fixed),
      net_profit: net,
      net_margin_pct: pct(net),
      target_net_margin_pct: target,
      gap_pct: pct(net) != null ? r2((pct(net) as number) - target) : null,
      ad_budget_envelope: adEnvelope,
      ad_envelope_remaining: r2(adEnvelope - adSpend),
      cost_by_category: byCategory, // quebra real das taxas + ads (Fase 2.5)
      units,
      orders: orders.length,
    }
  }

  // ── Por SKU/anúncio (org/mês) ────────────────────────────────────────────

  async getByProduct(orgId: string, month?: string, limit = 200) {
    const ym = month ?? new Date().toISOString().slice(0, 7)
    const { start, endExcl } = monthRange(ym)

    const orders = await this.fetchOrders(orgId, start, endExcl)

    interface Agg { product_id: string; name: string; sku: string | null; revenue: number; cmvKnown: number; revenueWithCost: number; tax: number; units: number }
    const byProd = new Map<string, Agg>()
    // pra ratear taxa real do pedido (nível-pedido) entre seus produtos por receita
    const orderLines = new Map<string, Array<{ pid: string; rev: number }>>()
    const orderRev = new Map<string, number>()
    let totCmvKnown = 0, totRevWithCost = 0
    for (const o of orders) {
      const pid = o.product_id
      const lineRev = lineRevenue(o.source, o.sale_price, o.quantity)
      const ext = o.external_order_id
      if (ext) {
        orderRev.set(ext, (orderRev.get(ext) ?? 0) + lineRev)
        if (pid) { if (!orderLines.has(ext)) orderLines.set(ext, []); orderLines.get(ext)!.push({ pid, rev: lineRev }) }
      }
      if (!pid) continue
      const a = byProd.get(pid) ?? { product_id: pid, name: o.product_title ?? '(sem nome)', sku: o.sku ?? null, revenue: 0, cmvKnown: 0, revenueWithCost: 0, tax: 0, units: 0 }
      a.revenue += lineRev
      a.tax += num(o.tax_amount)
      if (o.cost_price != null) { a.cmvKnown += num(o.cost_price); a.revenueWithCost += lineRev; totCmvKnown += num(o.cost_price); totRevWithCost += lineRev }
      a.units += num(o.quantity)
      byProd.set(pid, a)
    }
    // razão de custo global (mesma do consolidado) p/ imputar custo faltante por SKU
    const costRatio = totRevWithCost > 0 ? totCmvKnown / totRevWithCost : 0

    // taxa real por pedido (exceto ads) → rateada por produto via receita
    const feesByOrder = await this.feesByOrder(orgId, ym)
    const feeByProduct = new Map<string, number>()
    for (const [ext, fee] of feesByOrder) {
      const lines = orderLines.get(ext)
      const total = orderRev.get(ext) ?? 0
      if (!lines || total <= 0) continue
      for (const ln of lines) {
        feeByProduct.set(ln.pid, (feeByProduct.get(ln.pid) ?? 0) + fee * (ln.rev / total))
      }
    }

    const adByProduct = await this.mlAdSpendByProduct(orgId, ym) // ACOS granular (mantido)
    const fixed = (await this.opCosts.getMonthlyTotal(orgId, ym)).total
    const cmByProd = new Map<string, number>()
    for (const a of byProd.values()) {
      const cmvTotal = a.cmvKnown + (a.revenue - a.revenueWithCost) * costRatio
      cmByProd.set(a.product_id, a.revenue - cmvTotal - a.tax - (feeByProduct.get(a.product_id) ?? 0))
    }
    const totalPosCm = [...cmByProd.values()].reduce((s, v) => s + Math.max(0, v), 0)

    const rows = [...byProd.values()].map((a) => {
      const cm = cmByProd.get(a.product_id) ?? 0
      const fixedAlloc = totalPosCm > 0 && cm > 0 ? fixed * (cm / totalPosCm) : 0
      const adSpend = adByProduct.get(a.product_id) ?? 0
      const net = cm - adSpend - fixedAlloc
      const pct = (n: number) => (a.revenue > 0 ? r2((n / a.revenue) * 100) : null)
      return {
        product_id: a.product_id,
        name: a.name,
        sku: a.sku,
        units: a.units,
        revenue: r2(a.revenue),
        platform_fees: r2(feeByProduct.get(a.product_id) ?? 0),
        contribution_margin: r2(cm),
        contribution_margin_pct: pct(cm),
        ad_spend: r2(adSpend),
        acos_pct: a.revenue > 0 && adSpend > 0 ? r2((adSpend / a.revenue) * 100) : null,
        fixed_cost_allocated: r2(fixedAlloc),
        net_profit: r2(net),
        net_margin_pct: pct(net),
      }
    })
    rows.sort((x, y) => x.net_profit - y.net_profit) // pior líquido primeiro
    return { month: ym, count: rows.length, products: rows.slice(0, limit) }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Pedidos não-cancelados do período (paginado). */
  private async fetchOrders(orgId: string, startIso: string, endExclIso: string) {
    const out: Array<{ source: string | null; product_id: string | null; product_title: string | null; sku: string | null; quantity: number; sale_price: number; cost_price: number | null; tax_amount: number | null; external_order_id: string | null }> = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('orders')
        .select('source, product_id, product_title, sku, quantity, sale_price, cost_price, tax_amount, external_order_id')
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

  /** Todas as linhas de platform_charges do mês (paginado). */
  private async fetchCharges(orgId: string, ym: string) {
    const { start, endExcl } = monthRange(ym)
    const from = start.slice(0, 10)
    const toExcl = endExcl.slice(0, 10)
    const out: Array<{ charge_category: string; detail_type: string; amount: number; external_order_id: string | null }> = []
    const PAGE = 1000
    for (let off = 0; ; off += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('platform_charges')
        .select('charge_category, detail_type, amount, external_order_id')
        .eq('organization_id', orgId)
        .gte('charge_date', from)
        .lt('charge_date', toExcl)
        .range(off, off + PAGE - 1)
      if (error) { this.logger.warn(`fetchCharges: ${error.message}`); break }
      const rows = (data ?? []).map(r => ({
        charge_category: (r as { charge_category: string }).charge_category,
        detail_type: (r as { detail_type: string }).detail_type,
        amount: num((r as { amount: number }).amount),
        external_order_id: (r as { external_order_id: string | null }).external_order_id ?? null,
      }))
      out.push(...rows)
      if (rows.length < PAGE) break
    }
    return out
  }

  /** Taxa real líquida por pedido (charge−credit), EXCETO ads — pro rateio por SKU. */
  private async feesByOrder(orgId: string, ym: string): Promise<Map<string, number>> {
    const charges = await this.fetchCharges(orgId, ym)
    const map = new Map<string, number>()
    for (const c of charges) {
      if (c.charge_category === 'ads') continue
      if (!c.external_order_id) continue
      const signed = c.detail_type === 'credit' ? -c.amount : c.amount
      map.set(c.external_order_id, r2((map.get(c.external_order_id) ?? 0) + signed))
    }
    return map
  }

  /** Atribui o gasto de ADS do ML por SKU (ACOS granular): spend da campanha ÷
   *  nº de itens → item(MLB) → products.ml_listing_id → product_id. */
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
    const spendByCamp = new Map<string, number>()
    for (const r of (repsRes.data ?? []) as Array<{ campaign_id: string; spend: number }>) {
      spendByCamp.set(r.campaign_id, (spendByCamp.get(r.campaign_id) ?? 0) + num(r.spend))
    }
    const prodByMlb = new Map<string, string>()
    for (const p of (prodsRes.data ?? []) as Array<{ id: string; ml_listing_id: string }>) {
      prodByMlb.set(p.ml_listing_id, p.id)
    }
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
/**
 * Fontes cujo `orders.sale_price` já é o TOTAL da linha (quantity embutida na
 * ingestão — 1 row por SKU com `sale_total`). As demais (mercadolivre, manual,
 * storefront) gravam o preço UNITÁRIO e precisam de × quantity.
 *
 * ⚠️ Ao adicionar um marketplace novo: se a ingestão dele grava sale_price como
 * total da linha (padrão Shopee/TikTok), inclua o source aqui — senão a DRE
 * dobra a receita dele em pedidos com quantity>1.
 */
const TOTAL_PRICE_SOURCES = new Set(['shopee', 'tiktok_shop'])

/** Receita da linha respeitando a semântica de sale_price de cada fonte. */
function lineRevenue(source: string | null, salePrice: unknown, quantity: unknown): number {
  const sp = num(salePrice)
  return source && TOTAL_PRICE_SOURCES.has(source) ? sp : sp * num(quantity)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
function r2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Fontes cujo orders.sale_price já é o TOTAL da linha (qty embutida na
 *  ingestão Shopee/TikTok) — NÃO multiplicar por quantity. ML grava unitário. */
const TOTAL_PRICE_SOURCES = new Set(['shopee', 'tiktok_shop'])
function lineRevenue(source: string | null, salePrice: unknown, quantity: unknown): number {
  return source && TOTAL_PRICE_SOURCES.has(source)
    ? num(salePrice)
    : num(salePrice) * num(quantity)
}
