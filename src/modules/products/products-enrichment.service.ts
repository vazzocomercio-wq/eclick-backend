import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

/**
 * Onda 1 M2 sprint 1 — Enriquecimento AI do catálogo.
 *
 * 2 responsabilidades:
 *   1. computeAiScore(product): score 0-100 composto de 10 componentes,
 *      breakdown em jsonb. Pure function, sem chamada AI.
 *   2. enrichProduct(orgId, productId): 1 chamada Sonnet recebe foto + dados
 *      e retorna ai_short_description, ai_long_description, ai_keywords,
 *      ai_target_audience, ai_use_cases, ai_pros, ai_cons, ai_seo_keywords,
 *      ai_seasonality_hint. Loga custo em ai_usage_log via catalog_product_id.
 *
 * Sprint 2 (M2.2) vai adicionar worker automático que detecta
 * ai_enrichment_pending=true e enriquece em background.
 */

const ENRICHMENT_VERSION = 'v1'

interface ProductRow {
  id:                 string
  organization_id:    string | null
  name:               string
  sku:                string | null
  brand:              string | null
  category:           string | null
  description:        string | null
  ml_title:           string | null
  gtin:               string | null
  weight_kg:          number | null
  width_cm:           number | null
  length_cm:          number | null
  height_cm:          number | null
  cost_price:         number | null
  price:              number | null
  stock:              number | null
  photo_urls:         string[] | null
  category_ml_id:     string | null
  has_variations:     boolean | null
  attributes:         Record<string, unknown> | null
  status:             string | null
}

export interface ScoreBreakdown {
  has_name:               { points: number; max: number }
  has_description:        { points: number; max: number }
  has_brand:              { points: number; max: number }
  has_sku:                { points: number; max: number }
  has_gtin:               { points: number; max: number }
  has_dimensions:         { points: number; max: number }
  has_photos:             { points: number; max: number }
  has_pricing:            { points: number; max: number }
  has_category_ml:        { points: number; max: number }
  has_attributes:         { points: number; max: number }
  total:                  number
}

export interface EnrichmentOutput {
  ai_short_description?:    string
  ai_long_description?:     string
  ai_keywords?:             string[]
  ai_target_audience?:      string
  ai_use_cases?:            string[]
  ai_pros?:                 string[]
  ai_cons?:                 string[]
  ai_seo_keywords?:         string[]
  ai_seasonality_hint?:     string
}

@Injectable()
export class ProductsEnrichmentService {
  private readonly logger = new Logger(ProductsEnrichmentService.name)

  constructor(private readonly llm: LlmService) {}

  // ════════════════════════════════════════════════════════════════════════
  // WORKER QUEUE (M2.2)
  // ════════════════════════════════════════════════════════════════════════

  /** L1 — Enriquecimento em massa.
   *  Marca produtos como pending=true (worker M2.2 enriquece em background).
   *  Aceita IDs explícitos OU filtros. Cap de segurança em 200 produtos/call.
   *
   *  Custo estimado: ~$0.02/produto × N. Caller deve confirmar antes de chamar.
   */
  async enrichBulk(orgId: string, body: {
    product_ids?:        string[]
    missing_enrichment?: boolean       // ai_enriched_at IS NULL
    ai_score_lt?:        number        // ai_score < N (inclusive null)
    limit?:              number
  }): Promise<{ marked: number; estimated_cost_usd: number }> {
    const cap = Math.max(1, Math.min(200, body.limit ?? 100))

    let q = supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: false })
      .eq('organization_id', orgId)
      .eq('ai_enrichment_pending', false) // só novos pendentes
      .neq('status', 'archived')
      .limit(cap)

    if (body.product_ids && body.product_ids.length > 0) {
      q = q.in('id', body.product_ids.slice(0, cap))
    } else {
      if (body.missing_enrichment) {
        q = q.is('ai_enriched_at', null)
      }
      if (typeof body.ai_score_lt === 'number') {
        const threshold = Math.max(0, Math.min(100, body.ai_score_lt))
        // OR: ai_score < threshold OR ai_score IS NULL (sem score conta como baixo)
        q = q.or(`ai_score.lt.${threshold},ai_score.is.null`)
      }
    }

    const { data: products, error: fetchErr } = await q
    if (fetchErr) throw new BadRequestException(`enrichBulk.fetch: ${fetchErr.message}`)

    const ids = (products ?? []).map(p => (p as { id: string }).id)
    if (ids.length === 0) return { marked: 0, estimated_cost_usd: 0 }

    const { error: updateErr } = await supabaseAdmin
      .from('products')
      .update({ ai_enrichment_pending: true, updated_at: new Date().toISOString() })
      .in('id', ids)
      .eq('organization_id', orgId) // tenant guard adicional
    if (updateErr) throw new BadRequestException(`enrichBulk.update: ${updateErr.message}`)

    this.logger.log(`[catalog.bulk] ${ids.length} produtos marcados pending — worker vai processar`)
    return {
      marked:             ids.length,
      estimated_cost_usd: ids.length * 0.02, // estimativa Sonnet ~$0.01-0.03
    }
  }

  /** Resumo do estado de enriquecimento da org — pra UI da bulk page. */
  async enrichmentSummary(orgId: string): Promise<{
    total:          number
    enriched:       number
    pending:        number
    missing:        number
    score_under_60: number
    score_under_40: number
  }> {
    const [total, enriched, pending, missing, scoreLow, scoreVeryLow] = await Promise.all([
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).neq('status', 'archived'),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).neq('status', 'archived')
        .not('ai_enriched_at', 'is', null),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).neq('status', 'archived')
        .eq('ai_enrichment_pending', true),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).neq('status', 'archived')
        .is('ai_enriched_at', null),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).neq('status', 'archived')
        .lt('ai_score', 60),
      supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId).neq('status', 'archived')
        .lt('ai_score', 40),
    ])

    return {
      total:          total.count        ?? 0,
      enriched:       enriched.count     ?? 0,
      pending:        pending.count      ?? 0,
      missing:        missing.count      ?? 0,
      score_under_60: scoreLow.count     ?? 0,
      score_under_40: scoreVeryLow.count ?? 0,
    }
  }

  /** Lista produtos com ai_enrichment_pending=true. Worker M2.2 chama
   *  isso a cada tick, processa cada um via enrichProduct(). */
  async listPendingEnrichment(maxItems = 5): Promise<Array<{ id: string; organization_id: string }>> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id')
      .eq('ai_enrichment_pending', true)
      .not('organization_id', 'is', null)
      .order('updated_at', { ascending: true })
      .limit(maxItems)
    if (error) {
      this.logger.warn(`[listPendingEnrichment] ${error.message}`)
      return []
    }
    return ((data ?? []) as Array<{ id: string; organization_id: string | null }>)
      .filter(r => r.organization_id !== null) as Array<{ id: string; organization_id: string }>
  }

  // ════════════════════════════════════════════════════════════════════════
  // SCORE
  // ════════════════════════════════════════════════════════════════════════

  /** Score 0-100, breakdown jsonb. Pure function. */
  computeAiScore(p: ProductRow): { score: number; breakdown: ScoreBreakdown } {
    const has_name        = scorePart(!!p.name?.trim() && p.name.trim().length >= 10, 5)
    const has_description = scorePart((p.description?.trim().length ?? 0) >= 200, 15)
    const has_brand       = scorePart(!!p.brand?.trim(), 5)
    const has_sku         = scorePart(!!p.sku?.trim(), 5)
    const has_gtin        = scorePart(!!p.gtin?.trim() && /^\d{8,14}$/.test(p.gtin.trim()), 5)
    const has_dimensions  = scorePart(
      !!p.weight_kg && !!p.width_cm && !!p.length_cm && !!p.height_cm,
      15,
    )
    const has_photos      = scorePart(
      Array.isArray(p.photo_urls) && p.photo_urls.length >= 3,
      20,
    )
    const has_pricing     = scorePart(!!p.price && p.price > 0 && !!p.cost_price && p.cost_price > 0, 10)
    const has_category_ml = scorePart(!!p.category_ml_id?.trim(), 10)
    const has_attributes  = scorePart(
      !!p.attributes && Object.keys(p.attributes).length >= 3,
      10,
    )

    const total =
      has_name.points + has_description.points + has_brand.points +
      has_sku.points + has_gtin.points + has_dimensions.points +
      has_photos.points + has_pricing.points + has_category_ml.points +
      has_attributes.points

    return {
      score:     Math.round(total),
      breakdown: {
        has_name, has_description, has_brand, has_sku, has_gtin,
        has_dimensions, has_photos, has_pricing, has_category_ml,
        has_attributes, total,
      },
    }
  }

  /** Recalcula score e persiste. NÃO chama AI. Pra usar pós-edit. */
  async recomputeScore(orgId: string, productId: string): Promise<{ score: number; breakdown: ScoreBreakdown }> {
    const product = await this.getProduct(orgId, productId)
    const { score, breakdown } = this.computeAiScore(product)
    await supabaseAdmin
      .from('products')
      .update({ ai_score: score, ai_score_breakdown: breakdown, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .eq('organization_id', orgId)
    return { score, breakdown }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ENRICH
  // ════════════════════════════════════════════════════════════════════════

  /** Enriquece via Sonnet. 1 call. Loga custo em ai_usage_log. */
  async enrichProduct(orgId: string, productId: string): Promise<{
    enrichment: EnrichmentOutput
    score:      number
    cost_usd:   number
  }> {
    const product = await this.getProduct(orgId, productId)

    // Marca pending=true durante chamada (UI pode mostrar loading)
    await supabaseAdmin
      .from('products')
      .update({ ai_enrichment_pending: true, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .eq('organization_id', orgId)

    try {
      const out = await this.llm.generateText({
        orgId,
        feature:    'catalog_enrichment',
        userPrompt: this.buildEnrichmentPrompt(product),
        jsonMode:   true,
        maxTokens:  2500,
        catalog:    { productId, operation: 'catalog_enrichment' },
      })

      const parsed = this.parseEnrichmentJson(out.text)
      if (!parsed) {
        await supabaseAdmin
          .from('products')
          .update({ ai_enrichment_pending: false, updated_at: new Date().toISOString() })
          .eq('id', productId)
        throw new BadRequestException('Sonnet retornou JSON inválido — tente novamente')
      }

      // Recalcula score com os dados existentes (enriquecimento não muda
      // os campos básicos que entram no score — só campos AI)
      const { score, breakdown } = this.computeAiScore(product)

      // Acumula custo histórico
      const newTotalCost = Number(((product as ProductRow & { ai_enrichment_cost_usd?: number })
        .ai_enrichment_cost_usd ?? 0)) + Number(out.costUsd)

      const { error } = await supabaseAdmin
        .from('products')
        .update({
          ai_short_description:   parsed.ai_short_description ?? null,
          ai_long_description:    parsed.ai_long_description  ?? null,
          ai_keywords:            parsed.ai_keywords          ?? [],
          ai_target_audience:     parsed.ai_target_audience   ?? null,
          ai_use_cases:           parsed.ai_use_cases         ?? [],
          ai_pros:                parsed.ai_pros              ?? [],
          ai_cons:                parsed.ai_cons              ?? [],
          ai_seo_keywords:        parsed.ai_seo_keywords      ?? [],
          ai_seasonality_hint:    parsed.ai_seasonality_hint  ?? null,
          ai_score:               score,
          ai_score_breakdown:     breakdown,
          ai_enriched_at:         new Date().toISOString(),
          ai_enrichment_version:  ENRICHMENT_VERSION,
          ai_enrichment_cost_usd: newTotalCost,
          ai_enrichment_pending:  false,
          updated_at:             new Date().toISOString(),
        })
        .eq('id', productId)
        .eq('organization_id', orgId)
      if (error) throw new BadRequestException(`enrichProduct.update: ${error.message}`)

      this.logger.log(`[catalog.enrich] ✓ ${productId} score=${score} cost=$${out.costUsd.toFixed(4)}`)
      return { enrichment: parsed, score, cost_usd: out.costUsd }
    } catch (e) {
      // Limpa pending mesmo em erro
      await supabaseAdmin
        .from('products')
        .update({ ai_enrichment_pending: false, updated_at: new Date().toISOString() })
        .eq('id', productId)
      throw e
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async getProduct(orgId: string, productId: string): Promise<ProductRow & { ai_enrichment_cost_usd?: number }> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id, name, sku, brand, category, description, ml_title, gtin, weight_kg, width_cm, length_cm, height_cm, cost_price, price, stock, photo_urls, category_ml_id, has_variations, attributes, status, ai_enrichment_cost_usd')
      .eq('id', productId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getProduct: ${error.message}`)
    if (!data) throw new NotFoundException('produto não encontrado')
    if ((data as { organization_id: string | null }).organization_id !== orgId) {
      throw new NotFoundException('produto não encontrado nesta organização')
    }
    return data as ProductRow & { ai_enrichment_cost_usd?: number }
  }

  private buildEnrichmentPrompt(p: ProductRow): string {
    return `Você é especialista em catálogo e marketing de e-commerce brasileiro.

Analise o produto abaixo e retorne 9 campos enriquecidos em JSON. Use TODA informação disponível pra inferir, mas nunca invente especificações que contradigam o que está dado.

## PRODUTO
Nome:           ${p.name}
Categoria:      ${p.category ?? 'N/I'}
Marca:          ${p.brand ?? 'N/I'}
SKU:            ${p.sku ?? 'N/I'}
GTIN:           ${p.gtin ?? 'N/I'}
Modelo ML:      ${p.ml_title ?? 'N/I'}
Dimensões:      ${[
  p.weight_kg && `${p.weight_kg}kg`,
  p.width_cm && `${p.width_cm}cm L`,
  p.length_cm && `${p.length_cm}cm C`,
  p.height_cm && `${p.height_cm}cm A`,
].filter(Boolean).join(' × ') || 'N/I'}
Variações:      ${p.has_variations ? 'Sim' : 'Não'}
Descrição atual:
${p.description?.trim() || '(sem descrição)'}

## ATRIBUTOS EXISTENTES
${JSON.stringify(p.attributes ?? {}, null, 2)}

## REGRAS
- ai_short_description: 1 frase punchy de até 100 chars, foco no benefício principal. Sem emoji.
- ai_long_description: 200-500 chars, parágrafos curtos. Foco em problema → solução. NÃO repetir nome do produto na primeira frase.
- ai_keywords: 8-15 keywords COMPACTAS (1-3 palavras cada). Pra busca interna do site. Em pt-BR.
- ai_target_audience: 1 frase descrevendo quem compra (ex: "Donas de casa que valorizam organização compacta da cozinha").
- ai_use_cases: 3-5 cenários CONCRETOS de uso (ex: "Organizar talheres na gaveta da cozinha").
- ai_pros: 3-5 pontos fortes do produto. Honestos, não superlativos.
- ai_cons: 1-3 limitações/quando NÃO comprar. Honesto reduz devolução.
- ai_seo_keywords: 5-10 keywords pra Google/marketplace, podem incluir long-tail (frases). Em pt-BR.
- ai_seasonality_hint: texto livre 1-2 frases sobre quando vende mais (Black Friday? Dia das Mães?). NULL se sem padrão sazonal claro.

Retorne APENAS o JSON (sem markdown, sem explicação):
{
  "ai_short_description": "...",
  "ai_long_description": "...",
  "ai_keywords": ["..."],
  "ai_target_audience": "...",
  "ai_use_cases": ["..."],
  "ai_pros": ["..."],
  "ai_cons": ["..."],
  "ai_seo_keywords": ["..."],
  "ai_seasonality_hint": "..."
}`
  }

  private parseEnrichmentJson(text: string): EnrichmentOutput | null {
    const cleaned = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim()
    try {
      const parsed = JSON.parse(cleaned)
      if (!parsed || typeof parsed !== 'object') return null
      const arr = (v: unknown): string[] =>
        Array.isArray(v) ? v.map(String).filter(s => s.trim().length > 0) : []
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.trim() ? v.trim() : undefined
      return {
        ai_short_description: str(parsed.ai_short_description),
        ai_long_description:  str(parsed.ai_long_description),
        ai_keywords:          arr(parsed.ai_keywords),
        ai_target_audience:   str(parsed.ai_target_audience),
        ai_use_cases:         arr(parsed.ai_use_cases),
        ai_pros:              arr(parsed.ai_pros),
        ai_cons:              arr(parsed.ai_cons),
        ai_seo_keywords:      arr(parsed.ai_seo_keywords),
        ai_seasonality_hint:  str(parsed.ai_seasonality_hint),
      }
    } catch {
      return null
    }
  }
}

function scorePart(condition: boolean, max: number): { points: number; max: number } {
  return { points: condition ? max : 0, max }
}
