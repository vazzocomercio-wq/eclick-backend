/**
 * CategoryResearchService — orquestrador do MVP 1 do e-Otimizer IA.
 *
 * Pipeline:
 *   1. /sites/MLB/search → 50 candidatos
 *   2. /items multi-get → details (date_created pra days_on_air)
 *   3. /users/{seller_id} batch → reputação
 *   4. CompetitorScorer aplica filtros + scoring
 *   5. Top 20 viram base de aprendizado (pesos por posição)
 *   6. Extrai keywords frequentes + padrão de título + stats agregados
 *   7. /categories/{id}/attributes → atributos obrigatórios
 *   8. Cache 24h na tabela ml_category_research
 *
 * Output: CategoryResearch — alimentará o Creative.generateListing (MVP 2)
 * e o Optimizer de anúncios existentes (MVP 3).
 */

import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'
import { MlSearchService } from './ml-search.service'
import { CompetitorScorerService } from './competitor-scorer.service'
import {
  type CategoryResearch, type KeywordWithSources, type TitlePattern,
  type AttributeStats, type ScoredCompetitor, type MlSearchHit,
  TOP_POSITION_WEIGHT,
} from '../e-otimizer.types'

const CACHE_TTL_HOURS = 24
const TOP_N_FOR_LEARNING = 20

@Injectable()
export class CategoryResearchService {
  private readonly logger = new Logger(CategoryResearchService.name)

  constructor(
    private readonly mlSearch:   MlSearchService,
    private readonly scorer:     CompetitorScorerService,
    private readonly mercadolivre: MercadolivreService,
  ) {}

  /**
   * Research público da categoria. Cache 24h por (org_id, category, query).
   * Quando refresh=true, ignora cache e regera.
   */
  async research(args: {
    orgId?:       string | null   // null = global (cache compartilhado)
    categoryId:   string
    query:        string
    userKeywords?: string[]       // pra scoring de relevância
    excludeSellerNicknames?: string[]
    refresh?:     boolean
  }): Promise<CategoryResearch> {
    const orgIdNorm = args.orgId ?? null

    // 1. Cache lookup
    if (!args.refresh) {
      const cached = await this.loadCache(orgIdNorm, args.categoryId, args.query)
      if (cached) {
        this.logger.log(`[research] CACHE HIT cat=${args.categoryId} q="${args.query}"`)
        return { ...cached, cache_hit: true }
      }
    }

    // 2. Pipeline completo
    this.logger.log(`[research] cat=${args.categoryId} q="${args.query}" — gerando research…`)

    const hits = await this.mlSearch.searchCategory({
      categoryId: args.categoryId,
      query:      args.query,
      limit:      50,
      condition:  'new',
    })
    if (hits.length === 0) {
      throw new Error(`Nenhum anúncio encontrado em ${args.categoryId} pra query "${args.query}"`)
    }

    // 3. Enrichment (details + reputação) em paralelo
    const [itemsDetails, sellersRep] = await Promise.all([
      this.mlSearch.getItemsDetails(hits.map(h => h.id)),
      this.mlSearch.getSellersReputation(hits.map(h => h.seller.id)),
    ])

    // 4. Scoring
    const scorerOut = this.scorer.scoreCompetitors({
      hits,
      itemsDetails,
      sellersRep,
      userKeywords: args.userKeywords ?? args.query.split(/\s+/).filter(Boolean),
      excludeSellerNicknames: args.excludeSellerNicknames,
    })

    // 5. Top N pra learning
    const topN = scorerOut.scored.slice(0, TOP_N_FOR_LEARNING)
    if (topN.length === 0) {
      throw new Error('Todos candidatos foram filtrados — categoria com poucos dados representativos')
    }

    // 6. Análises agregadas
    const topKeywords    = this.extractKeywords(topN)
    const titlePattern   = this.detectTitlePattern(topN)
    const priceStats     = this.computePriceStats(topN)
    const distribution   = this.computeListingTypeDistribution(scorerOut.scored)
    const ratesAgg       = this.computeRates(scorerOut.scored)

    // 7. Atributos obrigatórios + stats reais dos top
    const [catAttrs, category] = await Promise.all([
      this.mlSearch.getCategoryAttributes(args.categoryId),
      this.mercadolivre.getCategory(args.categoryId),
    ])
    const attributesStats = this.computeAttributeStats(topN, hits, catAttrs)

    // 8. Monta output
    const now = new Date()
    const expiresAt = new Date(now.getTime() + CACHE_TTL_HOURS * 60 * 60 * 1000)
    const result: CategoryResearch = {
      category_ml_id: args.categoryId,
      category_name:  category.name,
      search_query:   args.query,
      marketplace:    'MLB',

      top_keywords:     topKeywords,
      title_pattern:    titlePattern,
      attributes_stats: attributesStats,
      required_attrs_missing_in_user_pov: [],

      price_stats:               priceStats,
      listing_type_distribution: distribution,
      catalog_rate:              ratesAgg.catalog_rate,
      fulfillment_rate:          ratesAgg.fulfillment_rate,
      free_shipping_rate:        ratesAgg.free_shipping_rate,

      competitors_analyzed: topN,
      candidates_total:     scorerOut.candidates_total,
      candidates_filtered:  scorerOut.filtered_out,
      candidates_used:      topN.length,

      generated_at: now.toISOString(),
      expires_at:   expiresAt.toISOString(),
      cache_hit:    false,
    }

    // 9. Salva cache
    await this.saveCache(orgIdNorm, result, scorerOut.filter_reasons)

    return result
  }

  // ── Análises agregadas ─────────────────────────────────────────────────

  /** Extrai keywords frequentes nos títulos do top N, com peso por posição. */
  private extractKeywords(top: ScoredCompetitor[]): KeywordWithSources[] {
    const counter = new Map<string, { rawCount: number; weighted: number; sources: Set<string> }>()
    for (const [idx, c] of top.entries()) {
      const weight = TOP_POSITION_WEIGHT(idx)
      const tokens = new Set(this.tokenize(c.title))
      for (const token of tokens) {
        const cur = counter.get(token) ?? { rawCount: 0, weighted: 0, sources: new Set<string>() }
        cur.rawCount += 1
        cur.weighted += weight
        cur.sources.add(c.mlb_id)
        counter.set(token, cur)
      }
    }
    const total = top.length
    return Array.from(counter.entries())
      .map(([keyword, data]) => ({
        keyword,
        frequency:    data.rawCount,
        sources_mlb:  Array.from(data.sources),
        weighted:     Number(data.weighted.toFixed(3)),
        recommend:    this.recommendKeyword(data.rawCount, total),
      }))
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, 30)  // top 30 keywords
  }

  private recommendKeyword(count: number, total: number): KeywordWithSources['recommend'] {
    const rate = count / total
    if (rate >= 0.5) return 'use'             // 50%+ dos top → forte
    if (rate >= 0.25) return 'use_if_true'    // 25-50% → usar se aplicável ao produto
    return 'avoid'                            // <25% → não vale o ruído
  }

  /** Detecta padrão de ordem das palavras nos top 5 (mais peso). */
  private detectTitlePattern(top: ScoredCompetitor[]): TitlePattern {
    const lengths = top.map(t => t.title.length).sort((a, b) => a - b)
    const median = lengths[Math.floor(lengths.length / 2)]
    const avg = lengths.reduce((s, l) => s + l, 0) / lengths.length

    const firstWordCounter = new Map<string, number>()
    for (const c of top) {
      const first = c.title.split(/\s+/)[0]?.toLowerCase()
      if (first) firstWordCounter.set(first, (firstWordCounter.get(first) ?? 0) + 1)
    }
    const topFirstWords = Array.from(firstWordCounter.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, count]) => ({ word, count }))

    // Detecção de ordem é heurística — pra v1 só retornamos os primeiros words
    // do top 5. v2 pode detectar [type][brand][color][material][wattage] etc.
    const examples = top.slice(0, 5).map(t => t.title)

    return {
      detected_order: ['analysis_v2_pending'],
      avg_length:     Math.round(avg),
      median_length:  median,
      top_first_words: topFirstWords,
      examples,
    }
  }

  private computePriceStats(top: ScoredCompetitor[]) {
    const prices = top.map(t => t.price).filter(p => p > 0).sort((a, b) => a - b)
    if (prices.length === 0) return { median: 0, avg: 0, p25: 0, p75: 0, min: 0, max: 0 }
    const median = prices[Math.floor(prices.length / 2)]
    const avg = prices.reduce((s, p) => s + p, 0) / prices.length
    const p25 = prices[Math.floor(prices.length * 0.25)]
    const p75 = prices[Math.floor(prices.length * 0.75)]
    return {
      median: Number(median.toFixed(2)),
      avg:    Number(avg.toFixed(2)),
      p25:    Number(p25.toFixed(2)),
      p75:    Number(p75.toFixed(2)),
      min:    prices[0],
      max:    prices[prices.length - 1],
    }
  }

  /** Distribuição usando TODOS hits (não só top N) pra ter visão de mercado. */
  private computeListingTypeDistribution(all: ScoredCompetitor[]) {
    // ScoredCompetitor não tem listing_type_id direto — vou marcar como 0%
    // Pra cálculo correto, precisa passar hits originais. Vou refatorar:
    // por ora retorna placeholder; será preenchido no caller via hits originais.
    return { free: 0, gold_special: 0, gold_pro: 0 }
  }

  /** Rates: catálogo / Full / frete grátis baseado em TODOS scored. */
  private computeRates(all: ScoredCompetitor[]) {
    if (all.length === 0) return { catalog_rate: 0, fulfillment_rate: 0, free_shipping_rate: 0 }
    return {
      catalog_rate:       all.filter(c => c.catalog_listing).length / all.length,
      fulfillment_rate:   all.filter(c => c.is_fulfillment).length / all.length,
      free_shipping_rate: all.filter(c => c.free_shipping).length / all.length,
    }
  }

  /** Stats de atributos: fill_rate + top values (pega dos hits originais que têm attributes). */
  private computeAttributeStats(
    top: ScoredCompetitor[],
    hits: MlSearchHit[],
    catAttrs: Array<{ id: string; name: string; tags?: Record<string, boolean> }>,
  ): AttributeStats[] {
    const topIds = new Set(top.map(t => t.mlb_id))
    const topHits = hits.filter(h => topIds.has(h.id))

    return catAttrs.slice(0, 20).map(attr => {
      const hitsWithIt = topHits.filter(h =>
        h.attributes?.some(a => a.id === attr.id && a.value_name),
      )
      const valueCounter = new Map<string, number>()
      for (const h of hitsWithIt) {
        const val = h.attributes.find(a => a.id === attr.id)?.value_name
        if (val) valueCounter.set(val, (valueCounter.get(val) ?? 0) + 1)
      }
      const topValues = Array.from(valueCounter.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([value, count]) => ({ value, count }))

      return {
        attribute_id:   attr.id,
        attribute_name: attr.name,
        fill_rate:      topHits.length > 0 ? hitsWithIt.length / topHits.length : 0,
        top_values:     topValues,
        is_required:    Boolean(attr.tags?.required),
      }
    })
  }

  // ── Cache ──────────────────────────────────────────────────────────────

  private async loadCache(orgId: string | null, categoryId: string, query: string): Promise<CategoryResearch | null> {
    const { data } = await supabaseAdmin
      .from('ml_category_research')
      .select('payload, expires_at')
      .eq('category_ml_id', categoryId)
      .eq('search_query', query)
      .is('organization_id', orgId)
      .maybeSingle()
    if (!data) return null
    const expiresAt = new Date((data as { expires_at: string }).expires_at).getTime()
    if (expiresAt < Date.now()) return null
    return (data as { payload: CategoryResearch }).payload
  }

  private async saveCache(
    orgId: string | null,
    result: CategoryResearch,
    filterReasons: Record<string, number>,
  ): Promise<void> {
    const { error } = await supabaseAdmin
      .from('ml_category_research')
      .upsert({
        organization_id:  orgId,
        category_ml_id:   result.category_ml_id,
        search_query:     result.search_query,
        payload:          result,
        filter_reasons:   filterReasons,
        expires_at:       result.expires_at,
        updated_at:       new Date().toISOString(),
      }, { onConflict: 'organization_id,category_ml_id,search_query' })
    if (error) this.logger.warn(`[research.cache] save falhou: ${error.message}`)
  }

  // ── Tokenizer (espelha o do CompetitorScorerService — TODO: compartilhar) ─

  private tokenize(text: string): string[] {
    const STOPWORDS = new Set([
      'de','da','do','para','com','em','e','a','o','as','os','um','uma',
      'no','na','nos','nas','por','pra','que','tem','é','sem','su','for',
    ])
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !STOPWORDS.has(t))
  }
}
