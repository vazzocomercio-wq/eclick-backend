import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/**
 * Health Score Engine.
 *
 * Combina sinais de F7 (quality), L2 (pricing+buy_box), L3 (fiscal,
 * status, policy) e dados internos (margin) em um score 0-100 por
 * anúncio. Insights e top_recommendation determinísticos (sem IA
 * por enquanto — mantém custo zero. L4 Sprint 8 pode adicionar IA
 * pra refinar recommendation).
 *
 * Performance: roda 1 query batched lendo dos caches existentes
 * (não chama ML). Pra Vazzo com 381 items, ~3s.
 */
@Injectable()
export class ListingHealthScoreService {
  private readonly logger = new Logger(ListingHealthScoreService.name)

  private static readonly WEIGHTS = {
    quality: 0.25,
    pricing: 0.20,
    fiscal:  0.15,
    status:  0.15,
    margin:  0.15,
    sales:   0.10,
  }

  async calculateAll(orgId: string, sellerId: number): Promise<{
    items_scored: number
    avg_score:    number
    low_score_count: number
    improved:     number
    degraded:     number
  }> {
    const t0 = Date.now()

    // 1. Lê de TODAS as fontes pra construir scores agregados
    const itemMap = await this.buildItemMap(orgId, sellerId)
    if (itemMap.size === 0) {
      this.logger.warn(`[health-score] org=${orgId.slice(0,8)} seller=${sellerId} sem items pra calcular`)
      return { items_scored: 0, avg_score: 0, low_score_count: 0, improved: 0, degraded: 0 }
    }

    // 2. Lê scores anteriores pra calcular trend
    const { data: prevRows } = await supabaseAdmin
      .from('ml_listing_health_scores')
      .select('ml_item_id, health_score')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
    const prevMap = new Map<string, number>()
    for (const p of (prevRows ?? []) as Array<{ ml_item_id: string; health_score: number }>) {
      prevMap.set(p.ml_item_id, p.health_score)
    }

    // 3. Compute e upsert em lote
    const upserts: Record<string, unknown>[] = []
    let sumScore = 0
    let lowCount = 0
    let improved = 0
    let degraded = 0

    for (const [itemId, ctx] of itemMap) {
      const breakdown = {
        quality_score: ctx.quality_score ?? 50,
        pricing_score: this.computePricingScore(ctx),
        fiscal_score:  ctx.fiscal_score ?? 50,
        status_score:  ctx.status_score,
        margin_score:  this.computeMarginScore(ctx.margin_pct),
        sales_score:   this.computeSalesScore(ctx.sales_30d, ctx.global_sales_p90),
      }
      const W = ListingHealthScoreService.WEIGHTS
      const total = Math.round(
        breakdown.quality_score * W.quality +
        breakdown.pricing_score * W.pricing +
        breakdown.fiscal_score  * W.fiscal  +
        breakdown.status_score  * W.status  +
        breakdown.margin_score  * W.margin  +
        breakdown.sales_score   * W.sales,
      )

      const issues = this.identifyKeyIssues(breakdown, ctx)
      const rec = this.generateTopRecommendation(breakdown, ctx, issues)

      const prev = prevMap.get(itemId)
      const trend = prev == null ? 'stable'
        : total > prev + 5 ? 'improving'
        : total < prev - 5 ? 'degrading'
        : 'stable'
      if (trend === 'improving') improved++
      else if (trend === 'degrading') degraded++

      upserts.push({
        organization_id:           orgId,
        seller_id:                 sellerId,
        ml_item_id:                itemId,
        product_id:                ctx.product_id,
        health_score:              total,
        quality_score:             breakdown.quality_score,
        pricing_score:             breakdown.pricing_score,
        fiscal_score:              breakdown.fiscal_score,
        status_score:              breakdown.status_score,
        margin_score:              breakdown.margin_score,
        sales_score:               breakdown.sales_score,
        key_issues:                issues,
        top_recommendation:        rec.text,
        top_recommendation_action: rec.action,
        top_recommendation_impact: rec.impact,
        trend,
        prev_score:                prev ?? null,
        score_change:              prev != null ? total - prev : 0,
        calculated_at:             new Date().toISOString(),
      })

      sumScore += total
      if (total < 60) lowCount++
    }

    // Upsert em batches de 100 (Supabase aguenta)
    const BATCH = 100
    for (let i = 0; i < upserts.length; i += BATCH) {
      const batch = upserts.slice(i, i + BATCH)
      const { error } = await supabaseAdmin
        .from('ml_listing_health_scores')
        .upsert(batch, { onConflict: 'organization_id,seller_id,ml_item_id' })
      if (error) this.logger.warn(`[health-score] batch ${i}: ${error.message}`)
    }

    const avg = upserts.length > 0 ? Math.round(sumScore / upserts.length) : 0
    this.logger.log(
      `[health-score] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `scored=${upserts.length} avg=${avg} low=${lowCount} ` +
      `improved=${improved} degraded=${degraded} em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scored: upserts.length,
      avg_score:    avg,
      low_score_count: lowCount,
      improved,
      degraded,
    }
  }

  /** Lê TODAS as fontes em paralelo e monta map indexado por ml_item_id. */
  private async buildItemMap(orgId: string, sellerId: number): Promise<Map<string, ItemContext>> {
    type Row<T> = T & { ml_item_id: string }

    const [quality, pricing, fiscal, status, products, orders] = await Promise.all([
      supabaseAdmin.from('ml_quality_snapshots')
        .select('ml_item_id, product_id, ml_score')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId),
      supabaseAdmin.from('ml_listing_pricing_suggestions')
        .select('ml_item_id, product_id, buy_box_status, price_difference_pct, visit_share, is_below_min_margin')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId),
      supabaseAdmin.from('ml_listing_fiscal_snapshots')
        .select('ml_item_id, product_id, fiscal_completeness_score, blocks_nfe, missing_fields')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId),
      supabaseAdmin.from('ml_listing_pause_classifications')
        .select('ml_item_id, ml_status, pause_category, pause_severity')
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId),
      supabaseAdmin.from('product_listings')
        .select('listing_id, product_id, products:products(id, cost_price, sku)')
        .eq('platform', 'mercadolivre')
        .eq('is_active', true),
      // Vendas dos últimos 30 dias agrupadas por marketplace_listing_id
      this.fetchSales30d(orgId, sellerId),
    ])

    const map = new Map<string, ItemContext>()

    // Inicializa pelo quality (mais provável de ter cobertura)
    for (const r of (quality.data ?? []) as Array<Row<{ product_id: string | null; ml_score: number | null }>>) {
      const ctx = this.ensureCtx(map, r.ml_item_id)
      ctx.product_id = ctx.product_id ?? r.product_id
      ctx.quality_score = r.ml_score
    }

    for (const r of (pricing.data ?? []) as Array<Row<{ product_id: string | null; buy_box_status: string | null; price_difference_pct: number | null; visit_share: string | null; is_below_min_margin: boolean }>>) {
      const ctx = this.ensureCtx(map, r.ml_item_id)
      ctx.product_id = ctx.product_id ?? r.product_id
      ctx.buy_box_status = r.buy_box_status
      ctx.price_diff_pct = r.price_difference_pct
      ctx.visit_share = r.visit_share
      ctx.is_below_min_margin = r.is_below_min_margin
    }

    for (const r of (fiscal.data ?? []) as Array<Row<{ product_id: string | null; fiscal_completeness_score: number | null; blocks_nfe: boolean; missing_fields: string[] }>>) {
      const ctx = this.ensureCtx(map, r.ml_item_id)
      ctx.product_id = ctx.product_id ?? r.product_id
      ctx.fiscal_score = r.fiscal_completeness_score
      ctx.blocks_nfe = r.blocks_nfe
      ctx.missing_fiscal = r.missing_fields
    }

    for (const r of (status.data ?? []) as Array<Row<{ ml_status: string; pause_category: string | null; pause_severity: string | null }>>) {
      const ctx = this.ensureCtx(map, r.ml_item_id)
      ctx.ml_status = r.ml_status
      ctx.pause_category = r.pause_category
      ctx.pause_severity = r.pause_severity
    }

    // Vínculo produto → cost_price + sku
    type ProductLink = { listing_id: string; product_id: string | null; products: { id: string; cost_price: number | null; sku: string | null } | { id: string; cost_price: number | null; sku: string | null }[] | null }
    const productByListing = new Map<string, { id: string; cost_price: number | null; sku: string | null } | null>()
    for (const r of (products.data ?? []) as ProductLink[]) {
      const prod = Array.isArray(r.products) ? r.products[0] : r.products
      productByListing.set(r.listing_id, prod ?? null)
    }
    for (const [itemId, ctx] of map) {
      const prod = productByListing.get(itemId)
      if (prod) {
        ctx.product_id = ctx.product_id ?? prod.id
        ctx.cost_price = prod.cost_price
      }
    }

    // Sales 30d
    const salesValues = [...orders.values()]
    const p90 = this.percentile(salesValues, 0.9) || 1
    for (const [itemId, count] of orders.entries()) {
      const ctx = this.ensureCtx(map, itemId)
      ctx.sales_30d = count
      ctx.global_sales_p90 = p90
    }
    for (const ctx of map.values()) {
      ctx.global_sales_p90 = ctx.global_sales_p90 ?? p90
      ctx.sales_30d = ctx.sales_30d ?? 0
    }

    // Status_score: default 100 (assume ativo); 0 se pause_classifications diz paused/closed
    for (const ctx of map.values()) {
      ctx.status_score = (ctx.ml_status === 'paused' || ctx.ml_status === 'closed') ? 0 : 100
    }

    // Margin pct: requer cost_price + um sale_price referencial. Como não
    // temos preço direto aqui, deixa null e usa default 50.
    // (Pode ser refinado em Sprint 8 com sale_price snapshot.)

    return map
  }

  private ensureCtx(map: Map<string, ItemContext>, itemId: string): ItemContext {
    let ctx = map.get(itemId)
    if (!ctx) {
      ctx = { product_id: null } as ItemContext
      map.set(itemId, ctx)
    }
    return ctx
  }

  private async fetchSales30d(orgId: string, sellerId: number): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString()
    const { data } = await supabaseAdmin
      .from('orders')
      .select('marketplace_listing_id')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .gte('sold_at', since)
      .not('marketplace_listing_id', 'is', null)
      .limit(10_000)
    const counts = new Map<string, number>()
    for (const r of (data ?? []) as Array<{ marketplace_listing_id: string }>) {
      counts.set(r.marketplace_listing_id, (counts.get(r.marketplace_listing_id) ?? 0) + 1)
    }
    return counts
  }

  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0
    const sorted = [...arr].sort((a, b) => a - b)
    const idx = Math.floor(sorted.length * p)
    return sorted[Math.min(idx, sorted.length - 1)]
  }

  private computePricingScore(ctx: ItemContext): number {
    if (ctx.buy_box_status === 'winning') return 100
    if (ctx.buy_box_status === 'sharing_first_place') return 70
    if (ctx.buy_box_status === 'losing') {
      const diff = Math.abs(ctx.price_diff_pct ?? 0)
      if (diff > 20) return 20
      if (diff > 10) return 40
      return 55
    }
    // Sem dados de pricing — score neutro
    return 50
  }

  private computeMarginScore(marginPct: number | null | undefined): number {
    if (marginPct == null) return 50
    if (marginPct < 0) return 0
    if (marginPct < 10) return 30
    if (marginPct < 20) return 60
    if (marginPct < 30) return 80
    return 95
  }

  private computeSalesScore(sales30d: number | null | undefined, p90: number | undefined): number {
    const s = sales30d ?? 0
    const ceil = p90 ?? 1
    if (s === 0) return 20
    if (ceil <= 0) return 50
    const ratio = Math.min(s / ceil, 1)
    return Math.round(20 + ratio * 80) // 20-100
  }

  private identifyKeyIssues(b: ScoreBreakdown, ctx: ItemContext): string[] {
    const issues: string[] = []
    if (b.quality_score < 60) issues.push('quality_low')
    if (b.pricing_score < 60) {
      issues.push(ctx.buy_box_status === 'losing' ? 'losing_buy_box' : 'price_high')
    }
    if (b.fiscal_score < 60 || ctx.blocks_nfe) issues.push('fiscal_incomplete')
    if (b.status_score === 0) issues.push('inactive')
    if (b.margin_score < 60) issues.push('margin_low')
    if (b.sales_score < 40) issues.push('low_sales')
    return issues
  }

  private generateTopRecommendation(b: ScoreBreakdown, ctx: ItemContext, issues: string[]): {
    text: string
    action: 'fix_fiscal' | 'improve_quality' | 'reduce_price' | 'activate_automation' | 'replenish_stock' | 'reactivate' | 'improve_margin' | 'apply_promotion' | 'none'
    impact: number | null
  } {
    // Prioridade: bloqueios > exposição > monetização

    if (ctx.blocks_nfe) {
      return {
        text: `Preencher dados fiscais (${(ctx.missing_fiscal ?? []).join(', ')}) — bloqueia emissão de NF-e`,
        action: 'fix_fiscal',
        impact: null,
      }
    }
    if (ctx.ml_status === 'paused' || ctx.ml_status === 'closed') {
      return {
        text: ctx.pause_category === 'out_of_stock'
          ? 'Repor estoque pra reativar anúncio'
          : `Reativar anúncio (motivo: ${ctx.pause_category ?? 'desconhecido'})`,
        action: ctx.pause_category === 'out_of_stock' ? 'replenish_stock' : 'reactivate',
        impact: null,
      }
    }
    if (b.quality_score < 50) {
      return {
        text: 'Melhorar qualidade do anúncio (ficha técnica + fotos) — score ML baixo',
        action: 'improve_quality',
        impact: null,
      }
    }
    if (ctx.buy_box_status === 'losing' && (ctx.price_diff_pct ?? 0) > 5) {
      return {
        text: `Reduzir preço pra ganhar Buy Box (${(ctx.price_diff_pct ?? 0).toFixed(1)}% acima do sugerido)`,
        action: 'reduce_price',
        impact: null,
      }
    }
    if (b.margin_score < 50 && b.margin_score > 0) {
      return {
        text: 'Avaliar custo / preço — margem está abaixo do mínimo recomendado',
        action: 'improve_margin',
        impact: null,
      }
    }
    if (b.sales_score < 40 && b.quality_score >= 70) {
      return {
        text: 'Aplicar promoção pra aumentar vendas — anúncio de qualidade mas pouco visto',
        action: 'apply_promotion',
        impact: null,
      }
    }
    if (issues.length === 0) {
      return { text: 'Anúncio saudável — manter rotina de scan', action: 'none', impact: null }
    }
    return { text: `Atenção a: ${issues.slice(0, 3).join(', ')}`, action: 'none', impact: null }
  }

  // ── Endpoint helpers ────────────────────────────────────────────────────

  async list(orgId: string, opts: { seller_id?: number; min_score?: number; max_score?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
    let q = supabaseAdmin
      .from('ml_listing_health_scores')
      .select('*')
      .eq('organization_id', orgId)
    if (opts.seller_id != null) q = q.eq('seller_id', opts.seller_id)
    if (opts.min_score != null) q = q.gte('health_score', opts.min_score)
    if (opts.max_score != null) q = q.lte('health_score', opts.max_score)
    q = q.order('health_score', { ascending: true }).limit(limit)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  async getOne(orgId: string, itemId: string) {
    const { data } = await supabaseAdmin
      .from('ml_listing_health_scores')
      .select('*')
      .eq('organization_id', orgId)
      .eq('ml_item_id', itemId)
      .maybeSingle()
    return data
  }
}

// ── Types internos ────────────────────────────────────────────────────────

interface ItemContext {
  product_id:        string | null
  quality_score?:    number | null
  buy_box_status?:   string | null
  price_diff_pct?:   number | null
  visit_share?:      string | null
  is_below_min_margin?: boolean
  fiscal_score?:     number | null
  blocks_nfe?:       boolean
  missing_fiscal?:   string[]
  ml_status?:        string
  pause_category?:   string | null
  pause_severity?:   string | null
  cost_price?:       number | null
  margin_pct?:       number | null
  sales_30d?:        number
  global_sales_p90?: number
  status_score:      number
}

interface ScoreBreakdown {
  quality_score: number
  pricing_score: number
  fiscal_score:  number
  status_score:  number
  margin_score:  number
  sales_score:   number
}
