import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import { buildPricingPrompt } from './pricing-ai.prompt'
import type {
  PricingSuggestion,
  PricingSuggestionStatus,
  PricingRules,
  PricingFactors,
  PricingAnalysis,
  PriceDirection,
  AnalysisFrequency,
} from './pricing-ai.types'

interface ProductRow {
  id:             string
  organization_id: string
  name:           string
  category:       string | null
  price:          number | null
  cost_price:     number | null
  stock:          number | null
  reorder_point:  number | null
  sku:            string | null
  status:         string | null
  ai_score:       number | null
}

@Injectable()
export class PricingAiService {
  private readonly logger = new Logger(PricingAiService.name)

  constructor(private readonly llm: LlmService) {}

  // ─────────────────────────────────────────────────────────────────
  // RULES (config global)
  // ─────────────────────────────────────────────────────────────────

  async getRules(orgId: string): Promise<PricingRules> {
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_rules')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (data) return data as PricingRules

    // Cria com defaults na primeira chamada
    const { data: created, error: insErr } = await supabaseAdmin
      .from('pricing_ai_rules')
      .insert({ organization_id: orgId })
      .select('*')
      .maybeSingle()
    if (insErr || !created) throw new BadRequestException(`Erro ao criar rules: ${insErr?.message}`)
    return created as PricingRules
  }

  async updateRules(orgId: string, patch: Partial<PricingRules>): Promise<PricingRules> {
    await this.getRules(orgId)  // garante que existe
    const allowed: (keyof PricingRules)[] = [
      'min_margin_pct', 'max_discount_pct', 'price_rounding',
      'auto_apply_enabled', 'auto_apply_max_change_pct',
      'rules', 'analysis_frequency',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) {
      if (k in patch) safe[k] = patch[k]
    }
    if (Object.keys(safe).length === 0) {
      throw new BadRequestException('nada pra atualizar')
    }
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_rules')
      .update(safe)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as PricingRules
  }

  // ─────────────────────────────────────────────────────────────────
  // ANALYZE — gera sugestões via IA
  // ─────────────────────────────────────────────────────────────────

  /** Analisa 1 produto, gera sugestão (status=pending OU auto_applied). */
  async analyzeProduct(orgId: string, productId: string): Promise<{
    suggestion: PricingSuggestion
    cost_usd:   number
  }> {
    const product = await this.fetchProduct(productId, orgId)
    if (!product.price || product.price <= 0) {
      throw new BadRequestException('Produto sem preço — não pode ser analisado')
    }

    const rules   = await this.getRules(orgId)
    const factors = await this.collectFactors(product)

    const { systemPrompt, userPrompt } = buildPricingPrompt({
      product: {
        id: product.id, name: product.name, category: product.category,
        price: product.price, cost_price: product.cost_price,
        stock: product.stock, reorder_point: product.reorder_point,
        sku: product.sku,
      },
      factors,
      min_margin_pct:   rules.min_margin_pct,
      max_discount_pct: rules.max_discount_pct,
      price_rounding:   rules.price_rounding,
    })

    const out = await this.llm.generateText({
      orgId,
      feature:     'pricing_ai_suggest',
      systemPrompt,
      userPrompt,
      maxTokens:   1500,
      temperature: 0.3,
      jsonMode:    true,
    })

    let parsed: {
      current_margin_pct?: number | null
      suggested_price:     number
      price_direction:     PriceDirection
      price_change_pct:    number
      scenarios:           PricingAnalysis['scenarios']
      reasoning:           string
      confidence:          number
      rules_applied:       Array<{ rule: string; applied: boolean; impact: string }>
    }
    try {
      parsed = JSON.parse(out.text)
    } catch {
      throw new BadRequestException('IA retornou JSON inválido — tente novamente')
    }

    const suggestedPrice = this.applyRounding(parsed.suggested_price, rules.price_rounding)
    const changePct      = product.price > 0
      ? Math.round(((suggestedPrice - product.price) / product.price) * 1000) / 10
      : 0
    const direction: PriceDirection =
      Math.abs(changePct) < 0.5 ? 'maintain'
      : changePct > 0            ? 'increase'
      :                            'decrease'

    // Decide se auto-aplica
    const autoApply =
      rules.auto_apply_enabled &&
      Math.abs(changePct) <= rules.auto_apply_max_change_pct

    const initialStatus: PricingSuggestionStatus = autoApply ? 'auto_applied' : 'pending'

    const analysis: PricingAnalysis = {
      factors:    { ...factors, suggested_margin_pct: this.calcMargin(suggestedPrice, product.cost_price) },
      reasoning:  parsed.reasoning,
      confidence: parsed.confidence,
      scenarios:  parsed.scenarios,
    }

    const insertRow = {
      organization_id:  orgId,
      product_id:       productId,
      current_price:    product.price,
      suggested_price:  suggestedPrice,
      price_change_pct: changePct,
      price_direction:  direction,
      analysis:         analysis as unknown as Record<string, unknown>,
      rules_applied:    parsed.rules_applied ?? [],
      status:           initialStatus,
      applied_at:       autoApply ? new Date().toISOString() : null,
      applied_price:    autoApply ? suggestedPrice : null,
    }

    const { data, error } = await supabaseAdmin
      .from('pricing_ai_suggestions')
      .insert(insertRow)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar: ${error?.message ?? 'sem dados'}`)

    if (autoApply) {
      await this.applyToProduct(orgId, productId, suggestedPrice)
    }

    return { suggestion: data as PricingSuggestion, cost_usd: out.costUsd }
  }

  /** Roda análise pra todos os produtos active da org (ou subset). */
  async analyzeAll(orgId: string, opts: { productIds?: string[]; maxItems?: number } = {}): Promise<{
    analyzed: number
    failed:   number
    cost_usd: number
  }> {
    let q = supabaseAdmin
      .from('products')
      .select('id')
      .eq('organization_id', orgId)
      .neq('status', 'archived')
      .gt('price', 0)
      .order('updated_at', { ascending: false })

    if (opts.productIds?.length) q = q.in('id', opts.productIds)
    if (opts.maxItems)            q = q.limit(opts.maxItems)
    else                          q = q.limit(50)

    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data?.length) return { analyzed: 0, failed: 0, cost_usd: 0 }

    let cost = 0, failed = 0, analyzed = 0
    // Sequencial pra não estourar rate limit do LLM (orgs com 1k produtos =
    // 1000 chamadas Sonnet → ~30min). Worker chama com maxItems pequeno
    // por tick.
    for (const p of data) {
      try {
        const r = await this.analyzeProduct(orgId, p.id)
        cost += r.cost_usd
        analyzed++
      } catch (e) {
        failed++
        this.logger.warn(`[pricing-ai] analyze ${p.id} falhou: ${(e as Error).message}`)
      }
    }

    // Atualiza last_analysis_at
    await supabaseAdmin
      .from('pricing_ai_rules')
      .update({ last_analysis_at: new Date().toISOString() })
      .eq('organization_id', orgId)

    return { analyzed, failed, cost_usd: cost }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUGESTÕES (lifecycle)
  // ─────────────────────────────────────────────────────────────────

  async listSuggestions(orgId: string, opts: {
    status?:    PricingSuggestionStatus
    productId?: string
    limit?:     number
    offset?:    number
  } = {}): Promise<{ items: PricingSuggestion[]; total: number }> {
    const limit  = Math.min(opts.limit  ?? 50, 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('pricing_ai_suggestions')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.status)    q = q.eq('status',     opts.status)
    if (opts.productId) q = q.eq('product_id', opts.productId)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { items: (data ?? []) as PricingSuggestion[], total: count ?? 0 }
  }

  async getSuggestion(id: string, orgId: string): Promise<PricingSuggestion> {
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_suggestions')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Sugestão não encontrada')
    return data as PricingSuggestion
  }

  async approve(id: string, orgId: string, overridePrice?: number): Promise<PricingSuggestion> {
    const sug = await this.getSuggestion(id, orgId)
    if (sug.status !== 'pending') {
      throw new BadRequestException(`Não pode aprovar em status '${sug.status}'`)
    }
    const finalPrice = overridePrice && overridePrice > 0 ? overridePrice : sug.suggested_price

    const { data, error } = await supabaseAdmin
      .from('pricing_ai_suggestions')
      .update({
        status:        'applied',
        applied_at:    new Date().toISOString(),
        applied_price: finalPrice,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)

    await this.applyToProduct(orgId, sug.product_id, finalPrice)
    return data as PricingSuggestion
  }

  async reject(id: string, orgId: string, reason?: string): Promise<PricingSuggestion> {
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_suggestions')
      .update({
        status:           'rejected',
        rejection_reason: reason ?? null,
      })
      .eq('id', id)
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle()
    if (error || !data) {
      throw new BadRequestException(`Erro ou não encontrado: ${error?.message ?? 'falha'}`)
    }
    return data as PricingSuggestion
  }

  async approveBatch(orgId: string, ids: string[]): Promise<{ approved: number; failed: number }> {
    let approved = 0, failed = 0
    for (const id of ids) {
      try { await this.approve(id, orgId); approved++ }
      catch (e) {
        failed++
        this.logger.warn(`[pricing-ai] approve batch ${id}: ${(e as Error).message}`)
      }
    }
    return { approved, failed }
  }

  // ─────────────────────────────────────────────────────────────────
  // DASHBOARD + HISTORY
  // ─────────────────────────────────────────────────────────────────

  async dashboard(orgId: string): Promise<{
    pending_count:      number
    applied_count:      number
    auto_applied_count: number
    avg_change_pct:     number | null
    last_analysis_at:   string | null
  }> {
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_suggestions')
      .select('status, price_change_pct')
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    const all = data ?? []
    const pending      = all.filter(r => r.status === 'pending').length
    const applied      = all.filter(r => r.status === 'applied').length
    const autoApplied  = all.filter(r => r.status === 'auto_applied').length
    const appliedPcts  = all.filter(r => r.status === 'applied' || r.status === 'auto_applied')
      .map(r => Math.abs((r as { price_change_pct: number | null }).price_change_pct ?? 0))
      .filter(n => n > 0)
    const avgChange = appliedPcts.length > 0
      ? appliedPcts.reduce((a, b) => a + b, 0) / appliedPcts.length
      : null

    const rules = await this.getRules(orgId)
    return {
      pending_count:      pending,
      applied_count:      applied,
      auto_applied_count: autoApplied,
      avg_change_pct:     avgChange,
      last_analysis_at:   rules.last_analysis_at,
    }
  }

  async productHistory(orgId: string, productId: string, limit = 30): Promise<PricingSuggestion[]> {
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_suggestions')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as PricingSuggestion[]
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────

  private async fetchProduct(productId: string, orgId: string): Promise<ProductRow> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id, name, category, price, cost_price, stock, reorder_point, sku, status, ai_score')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado')
    return data as ProductRow
  }

  /** Coleta fatores reais do produto (vendas, concorrência, estoque). */
  private async collectFactors(p: ProductRow): Promise<PricingFactors> {
    const factors: PricingFactors = {
      cost_price:         p.cost_price,
      current_margin_pct: this.calcMargin(p.price ?? 0, p.cost_price),
    }

    // Stock level qualitativo
    if (p.stock != null) {
      if (p.stock <= 0)                                factors.stock_level = 'critical'
      else if (p.stock <= (p.reorder_point ?? 5))      factors.stock_level = 'low'
      else if (p.stock > (p.reorder_point ?? 5) * 4)   factors.stock_level = 'high'
      else                                              factors.stock_level = 'normal'
    }

    // Vendas 30d (best-effort — tabela orders pode não ter `product_id` direto)
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', p.organization_id)
        .gte('created_at', since)
      factors.sales_velocity_30d = count ?? null
    } catch { /* opcional */ }

    // Concorrência (tabela competitors — best-effort)
    try {
      const { data: comps } = await supabaseAdmin
        .from('competitors')
        .select('price')
        .eq('product_id', p.id)
        .eq('organization_id', p.organization_id)
        .limit(20)
      const prices = (comps ?? []).map(c => c.price as number).filter(n => typeof n === 'number' && n > 0)
      if (prices.length > 0) {
        factors.competitor_avg_price = prices.reduce((a, b) => a + b, 0) / prices.length
        factors.competitor_min_price = Math.min(...prices)
        factors.competitor_max_price = Math.max(...prices)
      }
    } catch { /* opcional */ }

    // Stock days remaining (estimativa)
    if (p.stock != null && factors.sales_velocity_30d && factors.sales_velocity_30d > 0) {
      const dailyRate = factors.sales_velocity_30d / 30
      factors.stock_days_remaining = Math.round(p.stock / dailyRate)
    }

    // Sales trend (declining se vendas 30d < 60-90 dias avg) — best effort, deixar 'unknown' se não der pra calcular
    factors.sales_velocity_trend = 'unknown'

    return factors
  }

  private calcMargin(price: number, cost: number | null | undefined): number | null {
    if (!cost || cost <= 0 || !price || price <= 0) return null
    return Math.round(((price - cost) / price) * 1000) / 10
  }

  private applyRounding(price: number, mode: string): number {
    if (mode === 'none') return Math.round(price * 100) / 100
    if (mode === 'x.00') return Math.round(price)
    const base = Math.floor(price)
    const decimal = mode === 'x.99' ? 0.99 : mode === 'x.90' ? 0.90 : 0
    return base + decimal
  }

  /** Aplica preço ao produto (UPDATE products.price). Sprint futura:
   *  propagar pro ML/Shopee/IG via APIs — aqui só atualiza no SaaS. */
  private async applyToProduct(orgId: string, productId: string, newPrice: number): Promise<void> {
    const { error } = await supabaseAdmin
      .from('products')
      .update({ price: newPrice, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .eq('organization_id', orgId)
    if (error) {
      this.logger.error(`[pricing-ai] applyToProduct falhou: ${error.message}`)
      throw new BadRequestException(`Falha ao atualizar preço: ${error.message}`)
    }
    // TODO Sprint A1.B: propagar pra channel_titles, ml_*, shopee_*, etc.
  }

  // Pra worker
  async listOrgsForAnalysis(): Promise<Array<{ organization_id: string; analysis_frequency: AnalysisFrequency }>> {
    const { data, error } = await supabaseAdmin
      .from('pricing_ai_rules')
      .select('organization_id, analysis_frequency, next_analysis_at')
      .neq('analysis_frequency', 'manual')
      .or(`next_analysis_at.is.null,next_analysis_at.lt.${new Date().toISOString()}`)
      .limit(20)
    if (error) {
      this.logger.warn(`[pricing-ai] listOrgsForAnalysis: ${error.message}`)
      return []
    }
    return (data ?? []) as Array<{ organization_id: string; analysis_frequency: AnalysisFrequency }>
  }
}
