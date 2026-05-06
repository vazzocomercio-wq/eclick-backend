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

export interface PublicLandingProduct {
  id:                       string
  name:                     string
  brand:                    string | null
  category:                 string | null
  description:              string | null
  price:                    number | null
  photo_urls:               string[] | null
  gtin:                     string | null
  status:                   string | null
  condition:                string | null
  weight_kg:                number | null
  width_cm:                 number | null
  length_cm:                number | null
  height_cm:                number | null
  ml_permalink:             string | null
  ml_listing_id:            string | null
  ai_short_description:     string | null
  ai_long_description:      string | null
  ai_keywords:              string[]
  ai_target_audience:       string | null
  ai_use_cases:             string[]
  ai_pros:                  string[]
  ai_cons:                  string[]
  ai_seo_keywords:          string[]
  ai_seasonality_hint:      string | null
  ai_score:                 number | null
  ai_enriched_at:           string | null
  landing_published:        boolean
  landing_views:            number
  landing_published_at:     string | null
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
  /** Onda 1 hybrid C — multicanal */
  channel_titles?:          Record<string, string>
  channel_descriptions?:    Record<string, string>
  /** Delta extra — campos sugeridos + oficiais */
  ai_suggested_title?:      string
  ai_suggested_bullets?:    string[]
  ai_suggested_category?:   string
  differentials?:           string[]
  technical_sheet?:         Record<string, string>
  faq?:                     Array<{ q: string; a: string }>
  tags?:                    string[]
}

/** Marketplaces suportados pra channel_titles/descriptions. */
export const CHANNEL_KEYS = ['mercado_livre', 'shopee', 'amazon', 'magalu', 'loja_propria'] as const
export type ChannelKey = typeof CHANNEL_KEYS[number]

@Injectable()
export class ProductsEnrichmentService {
  private readonly logger = new Logger(ProductsEnrichmentService.name)

  constructor(private readonly llm: LlmService) {}

  // ════════════════════════════════════════════════════════════════════════
  // L3 — Recomendações IA
  // ════════════════════════════════════════════════════════════════════════

  /** Gera lista de "recomendações" — buckets de produtos que precisam de
   *  atenção. Cada bucket tem count + top 5 produtos pra ação rápida. */
  async getRecommendations(orgId: string): Promise<{
    buckets: Array<{
      key:         string
      title:       string
      description: string
      severity:    'critical' | 'warning' | 'opportunity' | 'success'
      count:       number
      action_path: string | null
      products:    Array<{ id: string; name: string; sku: string | null; ai_score: number | null }>
    }>
  }> {
    const baseSelect = 'id, name, sku, ai_score'

    const [
      lowScore, missingGtin, missingMlCategory, missingPhotos,
      enrichedNoLanding, landingNoViews, topPerformers,
    ] = await Promise.all([
      // Crítico: score < 40
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .lt('ai_score', 40)
        .order('ai_score', { ascending: true })
        .limit(5),

      // Warning: sem GTIN (penaliza no ML)
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .or('gtin.is.null,gtin.eq.')
        .limit(5),

      // Warning: sem categoria ML (não publica)
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .is('category_ml_id', null)
        .limit(5),

      // Warning: sem fotos suficientes
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .or('photo_urls.is.null,photo_urls.eq.{}')
        .limit(5),

      // Opportunity: enriquecido mas landing não publicada
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .not('ai_enriched_at', 'is', null)
        .eq('landing_published', false)
        .order('ai_score', { ascending: false })
        .limit(5),

      // Opportunity: landing publicada mas zero views (>7d)
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .eq('landing_published', true)
        .eq('landing_views', 0)
        .lt('landing_published_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .limit(5),

      // Success: top performers (enriquecido + landing + score alto)
      supabaseAdmin.from('products').select(baseSelect, { count: 'exact' })
        .eq('organization_id', orgId).neq('status', 'archived')
        .gte('ai_score', 80)
        .eq('landing_published', true)
        .order('ai_score', { ascending: false })
        .limit(5),
    ])

    type Row = { id: string; name: string; sku: string | null; ai_score: number | null }

    return {
      buckets: [
        {
          key:         'low_score',
          title:       'Atenção crítica — score < 40',
          description: 'Produtos com qualidade muito baixa. Revisão manual + re-enriquecimento sugeridos.',
          severity:    'critical',
          count:       lowScore.count ?? 0,
          action_path: '/dashboard/produtos/ai-bulk',
          products:    (lowScore.data ?? []) as Row[],
        },
        {
          key:         'missing_gtin',
          title:       'Sem código de barras (GTIN)',
          description: 'Produtos sem GTIN/EAN são penalizados em ML — visibilidade reduzida.',
          severity:    'warning',
          count:       missingGtin.count ?? 0,
          action_path: null,
          products:    (missingGtin.data ?? []) as Row[],
        },
        {
          key:         'missing_ml_category',
          title:       'Sem categoria Mercado Livre',
          description: 'Sem category_ml_id, o produto não pode ser publicado no ML.',
          severity:    'warning',
          count:       missingMlCategory.count ?? 0,
          action_path: null,
          products:    (missingMlCategory.data ?? []) as Row[],
        },
        {
          key:         'missing_photos',
          title:       'Sem fotos',
          description: 'Produtos sem foto têm conversão muito menor. Adicione pelo menos 3.',
          severity:    'warning',
          count:       missingPhotos.count ?? 0,
          action_path: null,
          products:    (missingPhotos.data ?? []) as Row[],
        },
        {
          key:         'enriched_no_landing',
          title:       'Pronto pra publicar landing',
          description: 'Enriquecidos pela IA mas com landing page despublicada. 1 clique resolve.',
          severity:    'opportunity',
          count:       enrichedNoLanding.count ?? 0,
          action_path: null,
          products:    (enrichedNoLanding.data ?? []) as Row[],
        },
        {
          key:         'landing_no_views',
          title:       'Landings sem tráfego (>7d)',
          description: 'Páginas publicadas mas sem acessos. Considere divulgar nos canais.',
          severity:    'opportunity',
          count:       landingNoViews.count ?? 0,
          action_path: null,
          products:    (landingNoViews.data ?? []) as Row[],
        },
        {
          key:         'top_performers',
          title:       'Top performers',
          description: 'Score ≥ 80 + landing publicada. Use como benchmark pros outros.',
          severity:    'success',
          count:       topPerformers.count ?? 0,
          action_path: null,
          products:    (topPerformers.data ?? []) as Row[],
        },
      ],
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // L2 — Landing page pública
  // ════════════════════════════════════════════════════════════════════════

  /** Toggle landing_published. Quando true, produto fica acessível em
   *  rota pública /p/:id (sem auth). User precisa explicitamente ativar. */
  async setLandingPublished(orgId: string, productId: string, published: boolean): Promise<{ landing_published: boolean; landing_published_at: string | null }> {
    const update: Record<string, unknown> = {
      landing_published: published,
      updated_at:        new Date().toISOString(),
    }
    if (published) update.landing_published_at = new Date().toISOString()

    const { data, error } = await supabaseAdmin
      .from('products')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', productId)
      .select('landing_published, landing_published_at')
      .single()
    if (error) throw new BadRequestException(`setLandingPublished: ${error.message}`)
    return data as { landing_published: boolean; landing_published_at: string | null }
  }

  /** Busca produto pra render PÚBLICO (sem auth). Retorna 404 se não
   *  publicado. Filtra apenas safe fields (sem cost_price, sem stock
   *  exato, etc). Bumpa landing_views (sem rate limit aqui — ok pra MVP). */
  async getLandingProduct(productId: string): Promise<PublicLandingProduct | null> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        id, name, brand, category, description, price,
        photo_urls, gtin, status, condition,
        weight_kg, width_cm, length_cm, height_cm,
        ml_permalink, ml_listing_id,
        ai_short_description, ai_long_description,
        ai_keywords, ai_target_audience, ai_use_cases,
        ai_pros, ai_cons, ai_seo_keywords, ai_seasonality_hint,
        ai_score, ai_enriched_at,
        landing_published, landing_views, landing_published_at
      `)
      .eq('id', productId)
      .eq('landing_published', true)
      .maybeSingle()
    if (error) throw new BadRequestException(`getLandingProduct: ${error.message}`)
    if (!data) return null

    // Bump views fire-and-forget (não bloqueia render)
    void supabaseAdmin
      .from('products')
      .update({ landing_views: ((data as { landing_views: number }).landing_views ?? 0) + 1 })
      .eq('id', productId)
      .then(() => undefined)

    return data as PublicLandingProduct
  }

  // ════════════════════════════════════════════════════════════════════════
  // WORKER QUEUE (M2.2)
  // ════════════════════════════════════════════════════════════════════════

  /** L1 hybrid C — cria product_enrichment_jobs row pra batch tracking.
   *  Worker dedicado drena product_ids do job, atualiza progress.
   *  Trigger M2.2 (single-product changes) continua funcionando em paralelo.
   *
   *  Cap 200 produtos/job (1 job = 1 batch atômico).
   */
  async enrichBulk(orgId: string, userId: string, body: {
    product_ids?:        string[]
    missing_enrichment?: boolean       // ai_enriched_at IS NULL
    ai_score_lt?:        number        // ai_score < N (inclusive null)
    limit?:              number
    options?:            Record<string, unknown>
    max_cost_usd?:       number
  }): Promise<{ job_id: string; total: number; estimated_cost_usd: number }> {
    const cap = Math.max(1, Math.min(200, body.limit ?? 100))

    let q = supabaseAdmin
      .from('products')
      .select('id', { count: 'exact', head: false })
      .eq('organization_id', orgId)
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
        q = q.or(`ai_score.lt.${threshold},ai_score.is.null`)
      }
    }

    const { data: products, error: fetchErr } = await q
    if (fetchErr) throw new BadRequestException(`enrichBulk.fetch: ${fetchErr.message}`)

    const ids = (products ?? []).map(p => (p as { id: string }).id)
    if (ids.length === 0) {
      throw new BadRequestException('Nenhum produto encontrado nos critérios — ajuste os filtros.')
    }

    const estimatedCost = ids.length * 0.02
    const maxCost = Math.max(0.5, Math.min(20, body.max_cost_usd ?? Math.max(1, estimatedCost * 1.5)))

    const { data: job, error: jobErr } = await supabaseAdmin
      .from('product_enrichment_jobs')
      .insert({
        organization_id:  orgId,
        user_id:          userId,
        product_ids:      ids,
        total_count:      ids.length,
        options:          body.options ?? {},
        max_cost_usd:     maxCost,
      })
      .select('id, total_count')
      .single()
    if (jobErr || !job) throw new BadRequestException(`enrichBulk.createJob: ${jobErr?.message ?? 'falhou'}`)

    this.logger.log(`[catalog.bulk] job ${(job as { id: string }).id} criado — ${ids.length} produtos, max=$${maxCost}`)
    return {
      job_id:             (job as { id: string }).id,
      total:              (job as { total_count: number }).total_count,
      estimated_cost_usd: estimatedCost,
    }
  }

  // ── Job worker support (Delta 2) ─────────────────────────────────────────

  async getEnrichmentJob(orgId: string, jobId: string): Promise<Record<string, unknown>> {
    const { data, error } = await supabaseAdmin
      .from('product_enrichment_jobs')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getEnrichmentJob: ${error.message}`)
    if (!data)  throw new NotFoundException('job não encontrado')
    return data as Record<string, unknown>
  }

  async cancelEnrichmentJob(orgId: string, jobId: string): Promise<Record<string, unknown>> {
    const job = await this.getEnrichmentJob(orgId, jobId)
    if (job.status === 'completed' || job.status === 'cancelled' || job.status === 'failed') return job
    const { data, error } = await supabaseAdmin
      .from('product_enrichment_jobs')
      .update({
        status:       'cancelled',
        completed_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', jobId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`cancelEnrichmentJob: ${error.message}`)
    return data as Record<string, unknown>
  }

  /** Lista jobs queued ordenados — worker pega o próximo. */
  async claimNextEnrichmentJob(): Promise<{
    id: string; organization_id: string; product_ids: string[];
    total_count: number; max_cost_usd: number; total_cost_usd: number;
    processed_count: number; results: unknown[];
  } | null> {
    const { data: queued } = await supabaseAdmin
      .from('product_enrichment_jobs')
      .select('id')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (!queued) return null

    const { data: claimed } = await supabaseAdmin
      .from('product_enrichment_jobs')
      .update({
        status:     'processing',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', (queued as { id: string }).id)
      .eq('status', 'queued')
      .select('id, organization_id, product_ids, total_count, max_cost_usd, total_cost_usd, processed_count, results')
      .maybeSingle()
    if (!claimed) return null
    return claimed as {
      id: string; organization_id: string; product_ids: string[];
      total_count: number; max_cost_usd: number; total_cost_usd: number;
      processed_count: number; results: unknown[];
    }
  }

  /** Processa 1 produto do job. Loop de chamadas vem do worker. */
  async processJobProduct(jobId: string, orgId: string, productId: string): Promise<{ success: boolean; cost: number; error?: string; score_after?: number | null }> {
    try {
      const result = await this.enrichProduct(orgId, productId)
      // Append em results
      const { data: job } = await supabaseAdmin
        .from('product_enrichment_jobs')
        .select('processed_count, success_count, results, total_cost_usd, max_cost_usd, total_count')
        .eq('id', jobId)
        .maybeSingle()
      if (!job) return { success: false, cost: 0, error: 'job desapareceu' }
      const j = job as { processed_count: number; success_count: number; results: unknown[]; total_cost_usd: number; max_cost_usd: number; total_count: number }
      const newCost = Number(j.total_cost_usd) + Number(result.cost_usd)
      await supabaseAdmin
        .from('product_enrichment_jobs')
        .update({
          processed_count: j.processed_count + 1,
          success_count:   j.success_count + 1,
          results:         [...j.results, { product_id: productId, status: 'success', score_after: result.score, cost_usd: result.cost_usd }],
          total_cost_usd:  newCost,
          updated_at:      new Date().toISOString(),
        })
        .eq('id', jobId)
      return { success: true, cost: result.cost_usd, score_after: result.score }
    } catch (e: unknown) {
      const msg = (e as Error).message
      const { data: job } = await supabaseAdmin
        .from('product_enrichment_jobs')
        .select('processed_count, error_count, results')
        .eq('id', jobId)
        .maybeSingle()
      if (job) {
        const j = job as { processed_count: number; error_count: number; results: unknown[] }
        await supabaseAdmin
          .from('product_enrichment_jobs')
          .update({
            processed_count: j.processed_count + 1,
            error_count:     j.error_count + 1,
            results:         [...j.results, { product_id: productId, status: 'error', error: msg }],
            updated_at:      new Date().toISOString(),
          })
          .eq('id', jobId)
      }
      return { success: false, cost: 0, error: msg }
    }
  }

  async finalizeJob(jobId: string, status: 'completed' | 'failed' | 'cancelled', errorMessage?: string): Promise<void> {
    const update: Record<string, unknown> = {
      status,
      completed_at: new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }
    if (errorMessage) update.error_message = errorMessage
    await supabaseAdmin
      .from('product_enrichment_jobs')
      .update(update)
      .eq('id', jobId)
  }

  /** Aplica sugestões da IA em campos do catálogo (sobrescreve os
   *  campos "oficiais"). Pattern: user revisa ai_suggested_* + accept.
   *
   *  Body controla quais sugestões aplicar:
   *  - title: copia ai_suggested_title → name
   *  - description: copia ai_long_description → description
   *  - bullets: copia ai_suggested_bullets → bullets
   *  - category: copia ai_suggested_category → category
   *  - all: aplica todas
   */
  async applySuggestions(orgId: string, productId: string, opts: {
    title?: boolean; description?: boolean; bullets?: boolean; category?: boolean; all?: boolean
  }): Promise<{ applied: string[] }> {
    const { data: row, error: fetchErr } = await supabaseAdmin
      .from('products')
      .select('ai_suggested_title, ai_suggested_bullets, ai_suggested_category, ai_long_description')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (fetchErr) throw new BadRequestException(`applySuggestions.fetch: ${fetchErr.message}`)
    if (!row) throw new NotFoundException('produto não encontrado')
    const r = row as {
      ai_suggested_title:    string | null
      ai_suggested_bullets:  string[] | null
      ai_suggested_category: string | null
      ai_long_description:   string | null
    }

    const apply: string[] = []
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }

    if ((opts.all || opts.title) && r.ai_suggested_title) {
      update.name = r.ai_suggested_title
      apply.push('title')
    }
    if ((opts.all || opts.description) && r.ai_long_description) {
      update.description = r.ai_long_description
      apply.push('description')
    }
    if ((opts.all || opts.bullets) && r.ai_suggested_bullets && r.ai_suggested_bullets.length > 0) {
      update.bullets = r.ai_suggested_bullets
      apply.push('bullets')
    }
    if ((opts.all || opts.category) && r.ai_suggested_category) {
      update.category = r.ai_suggested_category
      apply.push('category')
    }

    if (apply.length === 0) {
      return { applied: [] }
    }

    const { error: updateErr } = await supabaseAdmin
      .from('products')
      .update(update)
      .eq('id', productId)
      .eq('organization_id', orgId)
    if (updateErr) throw new BadRequestException(`applySuggestions.update: ${updateErr.message}`)

    return { applied: apply }
  }

  /** Setter explícito de catalog_status — usado pra paused/ready manual. */
  async setCatalogStatus(orgId: string, productId: string, status: 'paused' | 'ready' | 'draft'): Promise<{ catalog_status: string }> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ catalog_status: status, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', productId)
      .select('catalog_status')
      .single()
    if (error) throw new BadRequestException(`setCatalogStatus: ${error.message}`)
    return data as { catalog_status: string }
  }

  /** Health do catálogo: count por catalog_status. Pra dashboard L3 / bulk. */
  async getCatalogHealth(orgId: string): Promise<{
    by_status: Record<string, number>
    total:     number
  }> {
    // Roda 1 query agregada via RPC — supabase-js não suporta GROUP BY direto,
    // então usamos count em paralelo por status (mesmo pattern do enrichmentSummary).
    const STATUSES = ['incomplete', 'draft', 'enriching', 'enriched', 'ready', 'published', 'paused']
    const counts = await Promise.all(
      STATUSES.map(s =>
        supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).neq('status', 'archived')
          .eq('catalog_status', s)
          .then(r => ({ status: s, count: r.count ?? 0 })),
      ),
    )
    const total = await supabaseAdmin
      .from('products').select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).neq('status', 'archived')

    return {
      by_status: Object.fromEntries(counts.map(c => [c.status, c.count])),
      total:     total.count ?? 0,
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

      // Sanitiza channel_titles/descriptions — só aceita keys válidas
      const sanitizeChannels = (v: unknown): Record<string, string> => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
        const out: Record<string, string> = {}
        for (const k of CHANNEL_KEYS) {
          const val = (v as Record<string, unknown>)[k]
          if (typeof val === 'string' && val.trim()) out[k] = val.trim()
        }
        return out
      }

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
          channel_titles:         sanitizeChannels(parsed.channel_titles),
          channel_descriptions:   sanitizeChannels(parsed.channel_descriptions),
          ai_suggested_title:     parsed.ai_suggested_title    ?? null,
          ai_suggested_bullets:   parsed.ai_suggested_bullets  ?? [],
          ai_suggested_category:  parsed.ai_suggested_category ?? null,
          differentials:          parsed.differentials         ?? [],
          technical_sheet:        parsed.technical_sheet       ?? {},
          faq:                    parsed.faq                   ?? [],
          tags:                   parsed.tags                  ?? [],
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

## TÍTULOS POR CANAL (channel_titles)
Adapte o título do produto pra cada marketplace, respeitando regras específicas:
- mercado_livre: máx 60 chars. Formato: [Produto] [Característica] [Marca] [Modelo]. Sem CAPS LOCK, sem palavras tipo "promoção", "oferta", "frete grátis".
- shopee: máx 120 chars. Mais descritivo, pode usar hashtags no final (#categoria, #marca).
- amazon: máx 200 chars. Formato: [Marca] - [Produto] - [Características] - [Quantidade/Tamanho]. Capitalize First Letter.
- magalu: máx 150 chars. Similar ao ML mas mais longo.
- loja_propria: livre, foco em SEO + conversão.

## DESCRIÇÕES POR CANAL (channel_descriptions)
Adapte a descrição pra cada canal (use ai_long_description como base):
- mercado_livre: até 2000 chars, parágrafos curtos.
- shopee: até 1500 chars, pode usar emojis moderadamente.
- amazon: até 2000 chars, texto puro sem emoji.
- loja_propria: livre.

## CAMPOS SUGERIDOS (user aplica via "Aplicar Sugestões")
- ai_suggested_title: título de marketplace otimizado (60-80 chars), formato [Produto] [Característica Principal] [Marca] [Modelo]. Sem CAPS LOCK, sem palavras tipo "promoção".
- ai_suggested_bullets: 5-7 bullets com emoji ✅ no início, focados em benefícios (ex: "✅ Material premium em ABS — durabilidade garantida").
- ai_suggested_category: nome de categoria sugerida (texto livre, ex: "Casa, Decoração e Organização > Organizadores").

## CAMPOS DE CATÁLOGO (estruturados)
- differentials: 3-5 USPs comerciais (Unique Selling Propositions). Diferente de ai_pros: são razões pra comprar de você vs concorrente, não só benefícios do produto. Ex: ["Garantia estendida 12 meses", "Frete grátis acima de R$ 100"].
- technical_sheet: objeto chave-valor com mínimo 7 campos relevantes (Material, Cor, Dimensões, Peso, Marca, Modelo, Garantia, etc).
- faq: array de 5 perguntas de comprador real + resposta curta. Formato: [{ "q": "...", "a": "..." }].
- tags: 10-20 tags pra busca interna (1-2 palavras cada). Diferentes de keywords: tags categorizam, keywords são pra busca.

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
  "ai_seasonality_hint": "...",
  "channel_titles": {
    "mercado_livre": "...",
    "shopee": "...",
    "amazon": "...",
    "magalu": "...",
    "loja_propria": "..."
  },
  "channel_descriptions": {
    "mercado_livre": "...",
    "shopee": "...",
    "amazon": "...",
    "loja_propria": "..."
  },
  "ai_suggested_title": "...",
  "ai_suggested_bullets": ["..."],
  "ai_suggested_category": "...",
  "differentials": ["..."],
  "technical_sheet": { "Material": "...", "Cor": "..." },
  "faq": [{ "q": "...", "a": "..." }],
  "tags": ["..."]
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
      const obj = (v: unknown): Record<string, string> | undefined => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
        const out: Record<string, string> = {}
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (typeof val === 'string' && val.trim()) out[k] = val.trim()
        }
        return Object.keys(out).length > 0 ? out : undefined
      }

      // Parser de FAQ: array de { q, a }
      const faqArr = (v: unknown): Array<{ q: string; a: string }> | undefined => {
        if (!Array.isArray(v)) return undefined
        const out = (v as unknown[])
          .map(item => {
            if (!item || typeof item !== 'object') return null
            const o = item as Record<string, unknown>
            const q = String(o.q ?? o.question ?? '').trim()
            const a = String(o.a ?? o.answer  ?? '').trim()
            return q && a ? { q, a } : null
          })
          .filter((x): x is { q: string; a: string } => x !== null)
        return out.length > 0 ? out : undefined
      }

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
        channel_titles:       obj(parsed.channel_titles),
        channel_descriptions: obj(parsed.channel_descriptions),
        ai_suggested_title:   str(parsed.ai_suggested_title),
        ai_suggested_bullets: arr(parsed.ai_suggested_bullets),
        ai_suggested_category: str(parsed.ai_suggested_category),
        differentials:        arr(parsed.differentials),
        technical_sheet:      obj(parsed.technical_sheet),
        faq:                  faqArr(parsed.faq),
        tags:                 arr(parsed.tags),
      }
    } catch {
      return null
    }
  }
}

function scorePart(condition: boolean, max: number): { points: number; max: number } {
  return { points: condition ? max : 0, max }
}
