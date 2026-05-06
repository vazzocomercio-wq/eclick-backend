import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'
import {
  PRODUCT_ANALYSIS_PROMPT,
  buildListingPrompt,
  buildVariantPrompt,
  buildImagePromptsRequest,
  buildVideoPromptsRequest,
  type ListingPromptInput,
} from './creative.prompts'
import type { Provider } from '../ai/defaults'
import { getMarketplaceRules, type Marketplace } from './creative.marketplace-rules'

// ── Types refletindo o schema ─────────────────────────────────────────────

export interface CreativeProduct {
  id:                       string
  organization_id:          string
  user_id:                  string | null
  name:                     string
  category:                 string
  brand:                    string | null
  main_image_url:           string
  main_image_storage_path:  string
  dimensions:               Record<string, unknown>
  color:                    string | null
  material:                 string | null
  differentials:            string[]
  target_audience:          string | null
  sku:                      string | null
  ean:                      string | null
  ai_analysis:              Record<string, unknown>
  reference_images:         string[]
  competitor_links:         string[]
  reference_video_url:      string | null
  brand_identity_url:       string | null
  status:                   'draft' | 'analyzing' | 'ready' | 'archived'
  /** Onda 1 M1 — vínculo opcional com catálogo mestre `products` */
  product_id:               string | null
  created_at:               string
  updated_at:               string
}

export interface CreativeBriefing {
  id:                  string
  product_id:          string
  organization_id:     string
  target_marketplace:  Marketplace
  visual_style:        string
  /** @deprecated use environments[] */
  environment:         string | null
  environments:        string[]
  custom_environment:  string | null
  custom_prompt:       string | null
  background_color:    string
  use_logo:            boolean
  logo_url:            string | null
  logo_storage_path:   string | null
  communication_tone:  string
  image_count:         number
  image_format:        string
  image_prompts:       string[] | null
  video_prompts:       string[] | null
  marketplace_rules:   Record<string, unknown>
  is_active:           boolean
  created_at:          string
  updated_at:          string
}

export interface CreativeListing {
  id:                       string
  product_id:               string
  briefing_id:              string
  organization_id:          string
  title:                    string
  subtitle:                 string | null
  description:              string
  bullets:                  string[]
  technical_sheet:          Record<string, unknown>
  keywords:                 string[]
  search_tags:              string[]
  suggested_category:       string | null
  faq:                      Array<{ q: string; a: string }>
  commercial_differentials: string[]
  marketplace_variants:     Record<string, unknown>
  version:                  number
  parent_listing_id:        string | null
  generation_metadata:      Record<string, unknown>
  status:                   'draft' | 'generating' | 'review' | 'approved' | 'published' | 'archived'
  approved_at:              string | null
  approved_by:              string | null
  created_at:               string
  updated_at:               string
}

// ── DTOs ──────────────────────────────────────────────────────────────────

export interface CreateProductDto {
  name:                     string
  category:                 string
  main_image_url:           string
  main_image_storage_path:  string
  brand?:                   string
  dimensions?:              Record<string, unknown>
  color?:                   string
  material?:                string
  differentials?:           string[]
  target_audience?:         string
  sku?:                     string
  ean?:                     string
  reference_images?:        string[]
  competitor_links?:        string[]
  reference_video_url?:     string
  brand_identity_url?:      string
  /** Onda 1 M1 — vincula direto ao catálogo no momento da criação */
  product_id?:              string
}

export type UpdateProductDto = Partial<CreateProductDto> & { product_id?: string | null }

export interface CreateBriefingDto {
  target_marketplace:  Marketplace
  visual_style?:       string
  /** @deprecated use environments[] */
  environment?:        string
  environments?:       string[]
  custom_environment?: string
  custom_prompt?:      string
  background_color?:   string
  use_logo?:           boolean
  logo_url?:           string
  logo_storage_path?:  string
  communication_tone?: string
  image_count?:        number
  image_prompts?:      string[]
  video_prompts?:      string[]
  image_format?:       string
}

@Injectable()
export class CreativeService {
  private readonly logger = new Logger(CreativeService.name)

  constructor(private readonly llm: LlmService) {}

  // ════════════════════════════════════════════════════════════════════════
  // PRODUCTS
  // ════════════════════════════════════════════════════════════════════════

  async createProduct(orgId: string, userId: string, dto: CreateProductDto): Promise<CreativeProduct> {
    if (!dto.name?.trim()) throw new BadRequestException('name obrigatório')
    if (!dto.category?.trim()) throw new BadRequestException('category obrigatório')
    if (!dto.main_image_url?.trim()) throw new BadRequestException('main_image_url obrigatório')
    if (!dto.main_image_storage_path?.trim()) throw new BadRequestException('main_image_storage_path obrigatório')

    // Se product_id passado, valida que pertence ao mesmo org
    if (dto.product_id) {
      await this.assertCatalogProductInOrg(orgId, dto.product_id)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .insert({
        organization_id:         orgId,
        user_id:                 userId,
        name:                    dto.name.trim(),
        category:                dto.category.trim(),
        brand:                   dto.brand ?? null,
        main_image_url:          dto.main_image_url,
        main_image_storage_path: dto.main_image_storage_path,
        dimensions:              dto.dimensions ?? {},
        color:                   dto.color ?? null,
        material:                dto.material ?? null,
        differentials:           dto.differentials ?? [],
        target_audience:         dto.target_audience ?? null,
        sku:                     dto.sku ?? null,
        ean:                     dto.ean ?? null,
        reference_images:        dto.reference_images ?? [],
        competitor_links:        dto.competitor_links ?? [],
        reference_video_url:     dto.reference_video_url ?? null,
        brand_identity_url:      dto.brand_identity_url ?? null,
        product_id:              dto.product_id ?? null,
        status:                  'draft',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createProduct: ${error.message}`)
    return data as CreativeProduct
  }

  /** Valida que catalog_product pertence à mesma org. Lança 404/403. */
  private async assertCatalogProductInOrg(orgId: string, catalogProductId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id')
      .eq('id', catalogProductId)
      .maybeSingle()
    if (error) throw new BadRequestException(`assertCatalog: ${error.message}`)
    if (!data) throw new NotFoundException('produto do catálogo não encontrado')
    if ((data as { organization_id: string | null }).organization_id !== orgId) {
      throw new ForbiddenException('produto do catálogo pertence a outra organização')
    }
  }

  async listProducts(orgId: string, opts: {
    status?:        string
    search?:        string
    sort?:          'recent' | 'name'
    include_archived?: boolean
    limit?:         number
  } = {}): Promise<Array<CreativeProduct & { signed_image_url: string | null }>> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
    let q = supabaseAdmin
      .from('creative_products')
      .select('*')
      .eq('organization_id', orgId)
      .limit(limit)

    if (!opts.include_archived) q = q.neq('status', 'archived')
    if (opts.status)            q = q.eq('status', opts.status)

    // Search por name/sku/brand case-insensitive
    if (opts.search?.trim()) {
      const s = opts.search.trim().replace(/[,%]/g, ' ')
      q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,brand.ilike.%${s}%`)
    }

    // Sort
    if (opts.sort === 'name') {
      q = q.order('name', { ascending: true })
    } else {
      q = q.order('created_at', { ascending: false })
    }

    const { data, error } = await q
    if (error) throw new BadRequestException(`listProducts: ${error.message}`)
    const products = (data ?? []) as CreativeProduct[]
    return Promise.all(products.map(async p => ({
      ...p,
      signed_image_url: await this.signImage(p.main_image_storage_path, 3600).catch(() => null),
    })))
  }

  async getProduct(orgId: string, id: string): Promise<CreativeProduct> {
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`getProduct: ${error.message}`)
    if (!data) throw new NotFoundException('product não encontrado')
    return data as CreativeProduct
  }

  /** Como `getProduct` mas embute signed_image_url fresca (1h TTL) — usar
   *  no controller pra evitar 2 chamadas separadas do frontend. */
  async getProductWithSignedUrl(orgId: string, id: string): Promise<CreativeProduct & { signed_image_url: string | null }> {
    const product = await this.getProduct(orgId, id)
    const signed = await this.signImage(product.main_image_storage_path, 3600).catch(() => null)
    return { ...product, signed_image_url: signed }
  }

  async updateProduct(orgId: string, id: string, dto: UpdateProductDto): Promise<CreativeProduct> {
    await this.getProduct(orgId, id) // valida existência + tenant

    // Se product_id passado (não-null), valida tenant. Aceitar null = desvincular.
    if (dto.product_id) {
      await this.assertCatalogProductInOrg(orgId, dto.product_id)
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(dto) as Array<keyof UpdateProductDto>) {
      if (dto[k] !== undefined) patch[k] = dto[k]
    }
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateProduct: ${error.message}`)
    return data as CreativeProduct
  }

  // ════════════════════════════════════════════════════════════════════════
  // Onda 1 M1 — Bridge Creative ↔ Catálogo
  // ════════════════════════════════════════════════════════════════════════

  /** Lista creative_products vinculados a um produto do catálogo. */
  async listCreativesForCatalogProduct(orgId: string, catalogProductId: string): Promise<CreativeProduct[]> {
    await this.assertCatalogProductInOrg(orgId, catalogProductId)
    const { data, error } = await supabaseAdmin
      .from('creative_products')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', catalogProductId)
      .neq('status', 'archived')
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listCreativesForCatalogProduct: ${error.message}`)
    return (data ?? []) as CreativeProduct[]
  }

  /** Cria creative_product pré-preenchido com dados de um produto do catálogo.
   *  Usuário ainda precisa subir imagem (main_image_url + main_image_storage_path
   *  vêm do upload no frontend, este service só cria a row). */
  async createCreativeFromCatalogProduct(
    orgId: string,
    userId: string,
    catalogProductId: string,
    upload: { main_image_url: string; main_image_storage_path: string },
  ): Promise<CreativeProduct> {
    if (!upload.main_image_url || !upload.main_image_storage_path) {
      throw new BadRequestException('main_image_url e main_image_storage_path obrigatórios')
    }

    // Pega catalog product (já valida tenant)
    const { data: catalog, error } = await supabaseAdmin
      .from('products')
      .select('id, organization_id, name, brand, category, sku, gtin, weight_kg, width_cm, length_cm, height_cm, attributes, description, photo_urls')
      .eq('id', catalogProductId)
      .maybeSingle()
    if (error) throw new BadRequestException(`fetchCatalog: ${error.message}`)
    if (!catalog) throw new NotFoundException('produto do catálogo não encontrado')
    const cat = catalog as {
      id: string; organization_id: string | null; name: string; brand: string | null;
      category: string | null; sku: string | null; gtin: string | null;
      weight_kg: number | null; width_cm: number | null; length_cm: number | null;
      height_cm: number | null; attributes: Record<string, unknown> | null;
      description: string | null; photo_urls: string[] | null;
    }
    if (cat.organization_id !== orgId) {
      throw new ForbiddenException('produto do catálogo pertence a outra organização')
    }

    // Pré-preenche creative_product a partir do catalog
    const dimensions: Record<string, string> = {}
    if (cat.weight_kg) dimensions.peso         = `${cat.weight_kg} kg`
    if (cat.width_cm)  dimensions.largura      = `${cat.width_cm} cm`
    if (cat.length_cm) dimensions.profundidade = `${cat.length_cm} cm`
    if (cat.height_cm) dimensions.altura       = `${cat.height_cm} cm`

    return this.createProduct(orgId, userId, {
      name:                    cat.name,
      category:                cat.category ?? 'Diversos',
      brand:                   cat.brand ?? undefined,
      main_image_url:          upload.main_image_url,
      main_image_storage_path: upload.main_image_storage_path,
      dimensions:              Object.keys(dimensions).length > 0 ? dimensions : undefined,
      sku:                     cat.sku ?? undefined,
      ean:                     cat.gtin ?? undefined,
      reference_images:        cat.photo_urls ?? undefined,
      product_id:              cat.id,
    })
  }

  /** Cria um produto no catálogo (`products`) a partir de um creative_product
   *  e atualiza o vínculo. Usado quando user criou criativo do zero (cenário B)
   *  e depois quer "salvar no catálogo". */
  async creativeToCatalog(orgId: string, creativeId: string): Promise<{ creative: CreativeProduct; catalog_product_id: string }> {
    const creative = await this.getProduct(orgId, creativeId)
    if (creative.product_id) {
      throw new ConflictException(`criativo já vinculado ao catálogo (product_id=${creative.product_id})`)
    }

    // Extrai dimensions
    const dim = (creative.dimensions ?? {}) as Record<string, string>
    const parseNumber = (v: string | undefined): number | null => {
      if (!v) return null
      const m = v.match(/[\d.,]+/)?.[0]?.replace(',', '.')
      const n = m ? Number(m) : NaN
      return Number.isFinite(n) ? n : null
    }

    const { data: created, error } = await supabaseAdmin
      .from('products')
      .insert({
        organization_id: orgId,
        name:            creative.name,
        sku:             creative.sku,
        gtin:            creative.ean,
        brand:           creative.brand,
        category:        creative.category,
        description:     null,
        weight_kg:       parseNumber(dim.peso),
        width_cm:        parseNumber(dim.largura),
        length_cm:       parseNumber(dim.profundidade),
        height_cm:       parseNumber(dim.altura),
        photo_urls:      creative.main_image_url ? [creative.main_image_url, ...creative.reference_images] : creative.reference_images,
        attributes:      {
          color:           creative.color,
          material:        creative.material,
          target_audience: creative.target_audience,
          differentials:   creative.differentials,
          ai_analysis:     creative.ai_analysis,
        },
        status:          'draft',
        condition:       'new',
      })
      .select('id')
      .single()
    if (error) throw new BadRequestException(`creativeToCatalog.insert: ${error.message}`)
    const catalogId = (created as { id: string }).id

    // Atualiza vínculo
    await supabaseAdmin
      .from('creative_products')
      .update({ product_id: catalogId, updated_at: new Date().toISOString() })
      .eq('id', creative.id)

    const updated = await this.getProduct(orgId, creative.id)
    return { creative: updated, catalog_product_id: catalogId }
  }

  async archiveProduct(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('creative_products')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(`archiveProduct: ${error.message}`)
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════════
  // ANALYZE — Vision
  // ════════════════════════════════════════════════════════════════════════

  async analyzeProduct(orgId: string, id: string): Promise<CreativeProduct> {
    const product = await this.getProduct(orgId, id)
    await this.setStatus(id, 'analyzing')

    try {
      // Bucket creative é privado — gera signed URL fresca (5min TTL) a cada
      // chamada. URL salva em main_image_url no upload pode ter expirado.
      const signedUrl = await this.signImage(product.main_image_storage_path, 300)

      const out = await this.llm.analyzeImage({
        orgId,
        feature:    'creative_vision',
        imageUrl:   signedUrl,
        userPrompt: PRODUCT_ANALYSIS_PROMPT,
        jsonMode:   true,
        maxTokens:  1500,
        creative:   { productId: product.id, operation: 'product_analysis' },
      })

      const parsed = safeParseJson(out.text)
      if (!parsed) {
        await this.setStatus(id, 'ready') // mesmo sem análise, libera fluxo
        throw new BadRequestException('Vision retornou JSON inválido — tente novamente')
      }

      const { data, error } = await supabaseAdmin
        .from('creative_products')
        .update({
          ai_analysis: parsed,
          status:      'ready',
          updated_at:  new Date().toISOString(),
        })
        .eq('organization_id', orgId)
        .eq('id', id)
        .select('*')
        .single()
      if (error) throw new BadRequestException(`analyzeProduct.update: ${error.message}`)
      return data as CreativeProduct
    } catch (e) {
      await this.setStatus(id, 'ready')
      throw e
    }
  }

  private async setStatus(productId: string, status: CreativeProduct['status']): Promise<void> {
    await supabaseAdmin
      .from('creative_products')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', productId)
  }

  /** Gera signed URL pra um path do bucket privado `creative`. Usado pelas
   *  operações de IA (Vision, etc.) e exposto pelo controller pra o
   *  frontend renderizar thumbs sem precisar saber do path. */
  async signImage(storagePath: string, ttlSeconds = 300): Promise<string> {
    const { data, error } = await supabaseAdmin
      .storage
      .from('creative')
      .createSignedUrl(storagePath, ttlSeconds)
    if (error || !data?.signedUrl) {
      throw new BadRequestException(`signImage: ${error?.message ?? 'falhou'}`)
    }
    return data.signedUrl
  }

  // ════════════════════════════════════════════════════════════════════════
  // BRIEFINGS
  // ════════════════════════════════════════════════════════════════════════

  async createBriefing(orgId: string, productId: string, dto: CreateBriefingDto): Promise<CreativeBriefing> {
    await this.getProduct(orgId, productId) // tenant check
    if (!dto.target_marketplace) throw new BadRequestException('target_marketplace obrigatório')

    // Desativa briefings anteriores do mesmo produto (mantém só o ativo)
    await supabaseAdmin
      .from('creative_briefings')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('product_id', productId)
      .eq('is_active', true)

    const rules = getMarketplaceRules(dto.target_marketplace)
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .insert({
        product_id:         productId,
        organization_id:    orgId,
        target_marketplace: dto.target_marketplace,
        visual_style:       dto.visual_style ?? 'clean',
        environments:       dto.environments ?? (dto.environment ? [dto.environment] : []),
        custom_environment: dto.custom_environment ?? null,
        custom_prompt:      dto.custom_prompt ?? null,
        background_color:   dto.background_color ?? '#FFFFFF',
        use_logo:           dto.use_logo ?? false,
        logo_url:           dto.logo_url ?? null,
        logo_storage_path:  dto.logo_storage_path ?? null,
        communication_tone: dto.communication_tone ?? 'vendedor',
        image_count:        dto.image_count ?? 10,
        image_format:       dto.image_format ?? '1200x1200',
        image_prompts:      dto.image_prompts ?? null,
        video_prompts:      dto.video_prompts ?? null,
        marketplace_rules:  rules as unknown as Record<string, unknown>,
        is_active:          true,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createBriefing: ${error.message}`)
    return data as CreativeBriefing
  }

  async listBriefings(orgId: string, productId: string): Promise<CreativeBriefing[]> {
    await this.getProduct(orgId, productId)
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`listBriefings: ${error.message}`)
    return (data ?? []) as CreativeBriefing[]
  }

  async getBriefing(orgId: string, briefingId: string): Promise<CreativeBriefing> {
    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', briefingId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getBriefing: ${error.message}`)
    if (!data) throw new NotFoundException('briefing não encontrado')
    return data as CreativeBriefing
  }

  /** Atualiza qualquer campo do briefing — usado pra editar a base de
   *  prompts (image_prompts, video_prompts) e ajustes pontuais no fluxo. */
  async updateBriefing(orgId: string, briefingId: string, patch: Partial<{
    target_marketplace:  Marketplace
    visual_style:        string
    environments:        string[]
    custom_environment:  string | null
    custom_prompt:       string | null
    background_color:    string
    use_logo:            boolean
    logo_url:            string | null
    logo_storage_path:   string | null
    communication_tone:  string
    image_count:         number
    image_format:        string
    image_prompts:       string[] | null
    video_prompts:       string[] | null
  }>): Promise<CreativeBriefing> {
    // Sanity check de existência + scope da org
    await this.getBriefing(orgId, briefingId)

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) update[k] = v
    }

    const { data, error } = await supabaseAdmin
      .from('creative_briefings')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', briefingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateBriefing: ${error.message}`)
    return data as CreativeBriefing
  }

  /** Gera (via LLM) a base de prompts editaveis ligada ao briefing.
   *  Pipelines de imagem/video reusam essa base nas geracoes seguintes
   *  ao inves de chamar Sonnet toda vez. User pode editar a base entre
   *  geracoes pra refinar manualmente. */
  async generatePromptsBase(orgId: string, briefingId: string, opts: {
    scope:              'image' | 'video' | 'both'
    override?:          { provider: Provider; model: string }
    /** Default = briefing.image_count. */
    imageCount?:        number
    /** Default = 5. */
    videoCount?:        number
    /** Default = 10. */
    videoDurationSec?:  5 | 10
    /** Default = '9:16'. */
    videoAspectRatio?:  '1:1' | '16:9' | '9:16'
  }): Promise<CreativeBriefing> {
    const briefing = await this.getBriefing(orgId, briefingId)
    const product = await this.getProduct(orgId, briefing.product_id)

    const productInput = {
      name:            product.name,
      category:        product.category,
      brand:           product.brand,
      color:           product.color,
      material:        product.material,
      dimensions:      product.dimensions,
      differentials:   product.differentials,
      target_audience: product.target_audience,
      ai_analysis:     product.ai_analysis,
    }
    const briefingInput = {
      target_marketplace: briefing.target_marketplace,
      visual_style:       briefing.visual_style,
      environments:       briefing.environments ?? (briefing.environment ? [briefing.environment] : []),
      custom_environment: briefing.custom_environment,
      custom_prompt:      briefing.custom_prompt,
      background_color:   briefing.background_color,
      use_logo:           briefing.use_logo,
      communication_tone: briefing.communication_tone,
      image_count:        briefing.image_count,
    }

    const patch: { image_prompts?: string[]; video_prompts?: string[] } = {}

    if (opts.scope === 'image' || opts.scope === 'both') {
      const count = opts.imageCount ?? briefing.image_count ?? 10
      const out = await this.llm.generateText({
        orgId,
        feature:    'creative_image_prompts',
        userPrompt: buildImagePromptsRequest({ product: productInput, briefing: briefingInput, count }),
        jsonMode:   true,
        maxTokens:  4000,
        override:   opts.override,
        creative:   { productId: product.id, operation: 'prompts_base_image' },
      })
      patch.image_prompts = parsePromptsArrayJson(out.text, count)
    }

    if (opts.scope === 'video' || opts.scope === 'both') {
      const count = opts.videoCount ?? 5
      const durationSec = opts.videoDurationSec ?? 10
      const aspectRatio = opts.videoAspectRatio ?? '9:16'
      const out = await this.llm.generateText({
        orgId,
        feature:    'creative_video_prompts',
        userPrompt: buildVideoPromptsRequest({ product: productInput, briefing: briefingInput, count, durationSec, aspectRatio }),
        jsonMode:   true,
        maxTokens:  3000,
        override:   opts.override,
        creative:   { productId: product.id, operation: 'prompts_base_video' },
      })
      patch.video_prompts = parsePromptsArrayJson(out.text, count)
    }

    return this.updateBriefing(orgId, briefingId, patch)
  }

  // ════════════════════════════════════════════════════════════════════════
  // BRIEFING TEMPLATES (melhoria #2)
  // ════════════════════════════════════════════════════════════════════════

  async listBriefingTemplates(orgId: string): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .select('*')
      .eq('organization_id', orgId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(`listBriefingTemplates: ${error.message}`)
    return (data ?? []) as Array<Record<string, unknown>>
  }

  async createBriefingTemplate(orgId: string, userId: string, dto: {
    name:                string
    description?:        string
    target_marketplace:  Marketplace
    visual_style?:       string
    /** @deprecated use environments[] */
    environment?:        string
    environments?:       string[]
    custom_environment?: string
    custom_prompt?:      string
    background_color?:   string
    use_logo?:           boolean
    logo_url?:           string
    logo_storage_path?:  string
    communication_tone?: string
    image_count?:        number
    image_format?:       string
    is_default?:         boolean
  }): Promise<Record<string, unknown>> {
    if (!dto.name?.trim())              throw new BadRequestException('name obrigatório')
    if (!dto.target_marketplace)        throw new BadRequestException('target_marketplace obrigatório')

    // Se vai ser default, desativa o atual default da org
    if (dto.is_default) {
      await supabaseAdmin
        .from('creative_briefing_templates')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('is_default', true)
    }

    const { data, error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .insert({
        organization_id:     orgId,
        user_id:             userId,
        name:                dto.name.trim(),
        description:         dto.description ?? null,
        target_marketplace:  dto.target_marketplace,
        visual_style:        dto.visual_style ?? 'clean',
        environments:        dto.environments ?? (dto.environment ? [dto.environment] : []),
        custom_environment:  dto.custom_environment ?? null,
        custom_prompt:       dto.custom_prompt ?? null,
        background_color:    dto.background_color ?? '#FFFFFF',
        use_logo:            dto.use_logo ?? false,
        logo_url:            dto.logo_url ?? null,
        logo_storage_path:   dto.logo_storage_path ?? null,
        communication_tone:  dto.communication_tone ?? 'vendedor',
        image_count:         dto.image_count ?? 10,
        image_format:        dto.image_format ?? '1200x1200',
        is_default:          dto.is_default ?? false,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createBriefingTemplate: ${error.message}`)
    return data as Record<string, unknown>
  }

  async updateBriefingTemplate(orgId: string, id: string, patch: Partial<{
    name:                string
    description:         string
    target_marketplace:  Marketplace
    visual_style:        string
    /** @deprecated use environments[] */
    environment:         string
    environments:        string[]
    custom_environment:  string
    custom_prompt:       string
    background_color:    string
    use_logo:            boolean
    logo_url:            string
    logo_storage_path:   string
    communication_tone:  string
    image_count:         number
    image_format:        string
    is_default:          boolean
  }>): Promise<Record<string, unknown>> {
    if (patch.is_default === true) {
      await supabaseAdmin
        .from('creative_briefing_templates')
        .update({ is_default: false, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('is_default', true)
        .neq('id', id)
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) update[k] = v
    }
    const { data, error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateBriefingTemplate: ${error.message}`)
    if (!data) throw new NotFoundException('template não encontrado')
    return data as Record<string, unknown>
  }

  async deleteBriefingTemplate(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('creative_briefing_templates')
      .delete()
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new BadRequestException(`deleteBriefingTemplate: ${error.message}`)
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════════
  // LISTINGS — geração textual
  // ════════════════════════════════════════════════════════════════════════

  async generateListing(orgId: string, productId: string, briefingId: string): Promise<CreativeListing> {
    const product  = await this.getProduct(orgId, productId)
    const briefing = await this.getBriefing(orgId, briefingId)
    if (briefing.product_id !== product.id) {
      throw new BadRequestException('briefing pertence a outro produto')
    }

    const promptInput: ListingPromptInput = {
      product: {
        name:            product.name,
        category:        product.category,
        brand:           product.brand,
        color:           product.color,
        material:        product.material,
        dimensions:      product.dimensions,
        differentials:   product.differentials,
        target_audience: product.target_audience,
        ai_analysis:     product.ai_analysis,
      },
      briefing: {
        target_marketplace: briefing.target_marketplace,
        visual_style:       briefing.visual_style,
        communication_tone: briefing.communication_tone,
      },
    }

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt: buildListingPrompt(promptInput),
      jsonMode:   true,
      maxTokens:  3000,
      creative:   { productId: product.id, operation: 'text_generation' },
    })

    const parsed = safeParseJson(out.text)
    if (!parsed) throw new BadRequestException('LLM retornou JSON inválido — tente regenerar')

    const fields = normalizeListingFields(parsed)

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .insert({
        product_id:               product.id,
        briefing_id:              briefing.id,
        organization_id:          orgId,
        title:                    fields.title,
        subtitle:                 fields.subtitle,
        description:              fields.description,
        bullets:                  fields.bullets,
        technical_sheet:          fields.technical_sheet,
        keywords:                 fields.keywords,
        search_tags:              fields.search_tags,
        suggested_category:       fields.suggested_category,
        faq:                      fields.faq,
        commercial_differentials: fields.commercial_differentials,
        marketplace_variants:     {},
        version:                  1,
        parent_listing_id:        null,
        generation_metadata: {
          provider:      out.provider,
          model:         out.model,
          input_tokens:  out.inputTokens,
          output_tokens: out.outputTokens,
          cost_usd:      out.costUsd,
          latency_ms:    out.latencyMs,
          fallback_used: out.fallbackUsed,
        },
        status: 'review',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`generateListing.insert: ${error.message}`)
    return data as CreativeListing
  }

  async listListingsByProduct(orgId: string, productId: string): Promise<CreativeListing[]> {
    await this.getProduct(orgId, productId)
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', productId)
      .order('version', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listListingsByProduct: ${error.message}`)
    return (data ?? []) as CreativeListing[]
  }

  async getListing(orgId: string, listingId: string): Promise<CreativeListing> {
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getListing: ${error.message}`)
    if (!data) throw new NotFoundException('listing não encontrado')
    return data as CreativeListing
  }

  async updateListing(orgId: string, listingId: string, patch: Partial<{
    title:                    string
    subtitle:                 string
    description:              string
    bullets:                  string[]
    technical_sheet:          Record<string, unknown>
    keywords:                 string[]
    search_tags:              string[]
    suggested_category:       string
    faq:                      Array<{ q: string; a: string }>
    commercial_differentials: string[]
  }>): Promise<CreativeListing> {
    await this.getListing(orgId, listingId)
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k]
      if (v !== undefined) update[k] = v
    }
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateListing: ${error.message}`)
    return data as CreativeListing
  }

  /** Cria nova versão do listing usando o mesmo product+briefing, com instrução
   * adicional opcional. Não modifica a versão anterior — versionamento via
   * parent_listing_id + version incremental. */
  async regenerateListing(orgId: string, listingId: string, refinement?: string): Promise<CreativeListing> {
    const previous = await this.getListing(orgId, listingId)
    const product  = await this.getProduct(orgId, previous.product_id)
    const briefing = await this.getBriefing(orgId, previous.briefing_id)

    const promptInput: ListingPromptInput = {
      product: {
        name:            product.name,
        category:        product.category,
        brand:           product.brand,
        color:           product.color,
        material:        product.material,
        dimensions:      product.dimensions,
        differentials:   product.differentials,
        target_audience: product.target_audience,
        ai_analysis:     product.ai_analysis,
      },
      briefing: {
        target_marketplace: briefing.target_marketplace,
        visual_style:       briefing.visual_style,
        communication_tone: briefing.communication_tone,
      },
      refinement: refinement?.trim() || undefined,
    }

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt: buildListingPrompt(promptInput),
      jsonMode:   true,
      maxTokens:  3000,
      creative:   { productId: product.id, operation: 'text_generation' },
    })

    const parsed = safeParseJson(out.text)
    if (!parsed) throw new BadRequestException('LLM retornou JSON inválido — tente novamente')
    const fields = normalizeListingFields(parsed)

    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .insert({
        product_id:               product.id,
        briefing_id:              briefing.id,
        organization_id:          orgId,
        title:                    fields.title,
        subtitle:                 fields.subtitle,
        description:              fields.description,
        bullets:                  fields.bullets,
        technical_sheet:          fields.technical_sheet,
        keywords:                 fields.keywords,
        search_tags:              fields.search_tags,
        suggested_category:       fields.suggested_category,
        faq:                      fields.faq,
        commercial_differentials: fields.commercial_differentials,
        marketplace_variants:     {},
        version:                  previous.version + 1,
        parent_listing_id:        previous.id,
        generation_metadata: {
          provider:      out.provider,
          model:         out.model,
          input_tokens:  out.inputTokens,
          output_tokens: out.outputTokens,
          cost_usd:      out.costUsd,
          latency_ms:    out.latencyMs,
          fallback_used: out.fallbackUsed,
          refinement:    refinement ?? null,
        },
        status: 'review',
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`regenerateListing.insert: ${error.message}`)
    return data as CreativeListing
  }

  async approveListing(orgId: string, listingId: string, userId: string): Promise<CreativeListing> {
    await this.getListing(orgId, listingId)
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update({
        status:      'approved',
        approved_at: new Date().toISOString(),
        approved_by: userId,
        updated_at:  new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`approveListing: ${error.message}`)
    return data as CreativeListing
  }

  /** Gera variante do listing pra outro marketplace. Não cria row nova —
   * popula `marketplace_variants[<target>]` no listing existente. */
  async createVariant(orgId: string, listingId: string, target: Marketplace): Promise<CreativeListing> {
    const listing = await this.getListing(orgId, listingId)
    if ((listing.marketplace_variants ?? {})[target]) {
      throw new BadRequestException(`variante para ${target} já existe`)
    }

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt: buildVariantPrompt(
        { title: listing.title, description: listing.description, bullets: listing.bullets },
        target,
      ),
      jsonMode:   true,
      maxTokens:  2000,
      creative:   { productId: listing.product_id, operation: 'text_generation' },
    })

    const parsed = safeParseJson(out.text)
    if (!parsed) throw new BadRequestException('LLM retornou JSON inválido na variante')
    const variant = {
      title:       String(parsed.title ?? '').trim(),
      description: String(parsed.description ?? '').trim(),
      bullets:     Array.isArray(parsed.bullets) ? (parsed.bullets as unknown[]).map(String) : [],
    }

    const merged = { ...(listing.marketplace_variants ?? {}), [target]: variant }
    const { data, error } = await supabaseAdmin
      .from('creative_listings')
      .update({ marketplace_variants: merged, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', listingId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createVariant.update: ${error.message}`)
    return data as CreativeListing
  }

  // ════════════════════════════════════════════════════════════════════════
  // USAGE
  // ════════════════════════════════════════════════════════════════════════

  /** Resumo de uso/custo do org no escopo de Creative — agrega ai_usage_log
   * filtrando creative_product_id NOT NULL. */
  async getUsage(orgId: string, opts: { sinceDays?: number } = {}): Promise<{
    total_cost_usd:    number
    total_operations:  number
    by_operation:      Record<string, { count: number; cost_usd: number }>
    by_product_top10:  Array<{ product_id: string | null; product_name: string | null; count: number; cost_usd: number }>
  }> {
    const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ai_usage_log')
      .select('creative_product_id, creative_operation, cost_usd')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .not('creative_product_id', 'is', null)
      .limit(10_000)
    if (error) throw new BadRequestException(`getUsage: ${error.message}`)

    const rows = (data ?? []) as Array<{ creative_product_id: string | null; creative_operation: string | null; cost_usd: number | null }>
    const byOperation: Record<string, { count: number; cost_usd: number }> = {}
    const byProduct:   Record<string, { count: number; cost_usd: number }> = {}
    let totalCost = 0
    for (const r of rows) {
      const cost = Number(r.cost_usd ?? 0)
      totalCost += cost
      const op = r.creative_operation ?? 'unknown'
      const bucket = byOperation[op] ?? (byOperation[op] = { count: 0, cost_usd: 0 })
      bucket.count += 1
      bucket.cost_usd += cost
      if (r.creative_product_id) {
        const pb = byProduct[r.creative_product_id] ?? (byProduct[r.creative_product_id] = { count: 0, cost_usd: 0 })
        pb.count += 1
        pb.cost_usd += cost
      }
    }

    // Top 10 produtos com nome
    const productIds = Object.keys(byProduct)
    let nameMap = new Map<string, string>()
    if (productIds.length > 0) {
      const { data: names } = await supabaseAdmin
        .from('creative_products')
        .select('id, name')
        .in('id', productIds)
      nameMap = new Map((names ?? []).map((p: { id: string; name: string }) => [p.id, p.name]))
    }
    const topProducts = Object.entries(byProduct)
      .sort(([, a], [, b]) => b.cost_usd - a.cost_usd)
      .slice(0, 10)
      .map(([pid, agg]) => ({
        product_id:   pid,
        product_name: nameMap.get(pid) ?? null,
        count:        agg.count,
        cost_usd:     round6(agg.cost_usd),
      }))

    return {
      total_cost_usd:   round6(totalCost),
      total_operations: rows.length,
      by_operation:     mapValues(byOperation, v => ({ count: v.count, cost_usd: round6(v.cost_usd) })),
      by_product_top10: topProducts,
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeParseJson(text: string): Record<string, unknown> | null {
  // Tolera markdown ```json ... ``` envolvendo o output.
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function normalizeListingFields(parsed: Record<string, unknown>): {
  title:                    string
  subtitle:                 string | null
  description:              string
  bullets:                  string[]
  technical_sheet:          Record<string, unknown>
  keywords:                 string[]
  search_tags:              string[]
  suggested_category:       string | null
  faq:                      Array<{ q: string; a: string }>
  commercial_differentials: string[]
} {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map(x => String(x)).filter(s => s.length > 0) : []
  const faqRaw = Array.isArray(parsed.faq) ? (parsed.faq as unknown[]) : []
  const faq = faqRaw
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const obj = item as Record<string, unknown>
      const q = String(obj.q ?? obj.question ?? '').trim()
      const a = String(obj.a ?? obj.answer  ?? '').trim()
      return q && a ? { q, a } : null
    })
    .filter((x): x is { q: string; a: string } => x !== null)

  return {
    title:                    String(parsed.title ?? '').trim() || 'Título não gerado',
    subtitle:                 parsed.subtitle ? String(parsed.subtitle).trim() : null,
    description:              String(parsed.description ?? '').trim() || 'Descrição não gerada',
    bullets:                  arr(parsed.bullets),
    technical_sheet:          (parsed.technical_sheet && typeof parsed.technical_sheet === 'object')
                                ? parsed.technical_sheet as Record<string, unknown>
                                : {},
    keywords:                 arr(parsed.keywords),
    search_tags:              arr(parsed.search_tags),
    suggested_category:       parsed.suggested_category ? String(parsed.suggested_category).trim() : null,
    faq,
    commercial_differentials: arr(parsed.commercial_differentials),
  }
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

function mapValues<V, R>(obj: Record<string, V>, fn: (v: V) => R): Record<string, R> {
  const out: Record<string, R> = {}
  for (const k of Object.keys(obj)) out[k] = fn(obj[k])
  return out
}

/** Parse de array JSON de prompts retornado pelo LLM. Tolerante a wrapper
 *  markdown (```json ... ```). Pareado com parsePromptsArray dos pipelines. */
function parsePromptsArrayJson(text: string, expected: number): string[] {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map(p => typeof p === 'string' ? p.trim() : '')
    .filter(p => p.length > 0)
    .slice(0, expected)
}
