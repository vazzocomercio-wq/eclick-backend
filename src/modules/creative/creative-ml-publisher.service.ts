import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { CreativeService, type CreativeListing, type CreativeProduct } from './creative.service'

/**
 * F6 IA Criativo E3c — Publisher para Mercado Livre.
 *
 * Foco F1+F2: BUILD do payload + busca de categoria/atributos.
 * NÃO publica nada nesta sprint — só monta o objeto que iria pro
 * POST /items e retorna pra UI mostrar preview.
 *
 * F3 (futura): upload de pictures + video pro ML, POST /items com
 * status=paused, salva em creative_publications.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type MlListingType = 'free' | 'gold_special' | 'gold_pro'

export interface PublishContext {
  listing:    CreativeListing
  product:    CreativeProduct
  briefing_id: string
  approved_images: Array<{
    id:               string
    position:         number
    storage_path:     string
    signed_image_url: string
  }>
  approved_videos: Array<{
    id:               string
    position:         number
    storage_path:     string
    signed_video_url: string
    duration_seconds: number
  }>
  /** Sugestão de match em products.sku se houver. */
  sku_suggestion: { product_id: string; sku: string; price: number | null; stock: number | null } | null
}

export interface PreviewBuildOpts {
  /** UUIDs de creative_images aprovadas, na ORDEM desejada (1ª = capa) */
  image_ids:     string[]
  /** UUID de creative_videos aprovado (opcional, ML aceita 1) */
  video_id?:     string | null
  /** Preço em BRL */
  price:         number
  /** Estoque inicial */
  stock:         number
  /** ML listing type — default 'free' */
  listing_type?: MlListingType
  /** Se omitido, usa o predicted category. Frontend pode querer fixar. */
  category_id?:  string
  /** Atributos preenchidos pelo user. Cada item: { id: 'BRAND', value_name: 'Acme', value_id?: '...' } */
  attributes?:   Array<{ id: string; value_name?: string; value_id?: string }>
  /** Override condition. Default 'new'. */
  condition?:    'new' | 'used' | 'not_specified'
}

export interface PreviewResponse {
  ready:    boolean
  warnings: string[]
  predicted_category: {
    category_id:   string | null
    category_name: string | null
    domain_id:     string | null
    domain_name:   string | null
    suggested_attributes: Array<{ id: string; name: string; value_id?: string; value_name?: string }>
  }
  required_attributes: Array<{
    id:               string
    name:             string
    value_type:       string
    required:         boolean
    value_max_length?: number
    values?:          Array<{ id: string; name: string }>
    hint?:            string
  }>
  /** Objeto que iria pro POST /items. Frontend mostra como JSON formatado. */
  ml_payload: Record<string, unknown>
}

@Injectable()
export class CreativeMlPublisherService {
  private readonly logger = new Logger(CreativeMlPublisherService.name)

  constructor(
    private readonly creative: CreativeService,
    private readonly ml:       MercadolivreService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════
  // Context — pega listing + produto + imagens/vídeos aprovados + SKU match
  // ════════════════════════════════════════════════════════════════════════

  async getPublishContext(orgId: string, listingId: string): Promise<PublishContext> {
    const listing = await this.creative.getListing(orgId, listingId)
    const product = await this.creative.getProduct(orgId, listing.product_id)

    // Imagens aprovadas (ordenadas por position pra default)
    const { data: imgRows } = await supabaseAdmin
      .from('creative_images')
      .select('id, position, storage_path')
      .eq('organization_id', orgId)
      .eq('product_id', product.id)
      .eq('status', 'approved')
      .not('storage_path', 'is', null)
      .order('position', { ascending: true })

    const approvedImages = await Promise.all(
      (imgRows ?? []).map(async (r: { id: string; position: number; storage_path: string }) => ({
        id:               r.id,
        position:         r.position,
        storage_path:     r.storage_path,
        signed_image_url: await this.creative.signImage(r.storage_path, 3600),
      })),
    )

    // Vídeos aprovados
    const { data: vidRows } = await supabaseAdmin
      .from('creative_videos')
      .select('id, position, storage_path, duration_seconds')
      .eq('organization_id', orgId)
      .eq('product_id', product.id)
      .eq('status', 'approved')
      .not('storage_path', 'is', null)
      .order('position', { ascending: true })

    const approvedVideos = await Promise.all(
      (vidRows ?? []).map(async (r: { id: string; position: number; storage_path: string; duration_seconds: number }) => ({
        id:               r.id,
        position:         r.position,
        storage_path:     r.storage_path,
        signed_video_url: await this.creative.signImage(r.storage_path, 3600),
        duration_seconds: r.duration_seconds,
      })),
    )

    // SKU match em products legacy (opcional)
    let skuSuggestion: PublishContext['sku_suggestion'] = null
    if (product.sku) {
      const { data: prodMatch } = await supabaseAdmin
        .from('products')
        .select('id, sku, price, stock')
        .eq('organization_id', orgId)
        .eq('sku', product.sku)
        .limit(1)
        .maybeSingle()
      if (prodMatch) {
        const m = prodMatch as { id: string; sku: string; price: number | null; stock: number | null }
        skuSuggestion = {
          product_id: m.id,
          sku:        m.sku,
          price:      m.price,
          stock:      m.stock,
        }
      }
    }

    return {
      listing,
      product,
      briefing_id:     listing.briefing_id,
      approved_images: approvedImages,
      approved_videos: approvedVideos,
      sku_suggestion:  skuSuggestion,
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Wrappers do MercadolivreService (mantém front desacoplado de ML direto)
  // ════════════════════════════════════════════════════════════════════════

  async predictCategoryFromTitle(title: string): Promise<PreviewResponse['predicted_category']> {
    const r = await this.ml.predictCategory(title)
    return {
      category_id:   r.category_id,
      category_name: r.category_name,
      domain_id:     r.domain_id,
      domain_name:   r.domain_name,
      suggested_attributes: r.attributes,
    }
  }

  async getRequiredAttributes(categoryId: string): Promise<PreviewResponse['required_attributes']> {
    const all = await this.ml.getCategoryAttributes(categoryId)
    return all
      .filter(a => a.tags?.required === true || a.tags?.catalog_required === true)
      .map(a => ({
        id:               a.id,
        name:             a.name,
        value_type:       a.value_type,
        required:         true,
        value_max_length: a.value_max_length,
        values:           a.values,
        hint:             a.hint,
      }))
  }

  // ════════════════════════════════════════════════════════════════════════
  // Build do payload completo + warnings
  // ════════════════════════════════════════════════════════════════════════

  async buildPreview(orgId: string, listingId: string, opts: PreviewBuildOpts): Promise<PreviewResponse> {
    const ctx = await this.getPublishContext(orgId, listingId)
    const { listing, product, approved_images, approved_videos } = ctx

    const warnings: string[] = []

    // Validação básica
    if (!opts.image_ids || opts.image_ids.length === 0) {
      warnings.push('Pelo menos 1 imagem aprovada deve ser selecionada.')
    }
    if (opts.image_ids?.length > 10) {
      warnings.push('Máximo 10 imagens no Mercado Livre. Excedente será ignorado.')
    }
    if (!Number.isFinite(opts.price) || opts.price <= 0) {
      warnings.push('Preço inválido — informe um valor positivo em BRL.')
    }
    if (!Number.isFinite(opts.stock) || opts.stock < 0) {
      warnings.push('Estoque inválido — informe quantidade não-negativa.')
    }

    // Resolve imagens (preserva ordem que veio em opts.image_ids)
    const imageMap = new Map(approved_images.map(i => [i.id, i]))
    const orderedImages = (opts.image_ids ?? [])
      .map(id => imageMap.get(id))
      .filter((i): i is typeof approved_images[number] => !!i)
      .slice(0, 10)
    if (orderedImages.length < (opts.image_ids?.length ?? 0)) {
      warnings.push('Algumas imagens informadas não foram encontradas (não estão aprovadas).')
    }
    const pictures = orderedImages.map(i => ({ source: i.signed_image_url }))

    // Resolve vídeo (opcional)
    let videoPayload: { id: string } | null = null
    if (opts.video_id) {
      const video = approved_videos.find(v => v.id === opts.video_id)
      if (!video) {
        warnings.push('Vídeo informado não está aprovado ou não existe.')
      } else {
        videoPayload = { id: video.id } // F3 fará upload pro ML e pegará o video_id real
      }
    }

    // Categoria — predict se não veio
    let categoryId      = opts.category_id ?? null
    let categoryName    = null as string | null
    let suggestedAttrs  = [] as PreviewResponse['predicted_category']['suggested_attributes']
    let domainId        = null as string | null
    let domainName      = null as string | null

    const predicted = await this.predictCategoryFromTitle(listing.title)
    if (!categoryId) categoryId = predicted.category_id
    categoryName    = predicted.category_name
    suggestedAttrs  = predicted.suggested_attributes
    domainId        = predicted.domain_id
    domainName      = predicted.domain_name

    if (!categoryId) {
      warnings.push('Não foi possível predizer a categoria do anúncio. Defina manualmente.')
    }

    // Required attributes
    let requiredAttrs: PreviewResponse['required_attributes'] = []
    if (categoryId) {
      requiredAttrs = await this.getRequiredAttributes(categoryId)
    }

    // Valida attributes preenchidos
    const filled = new Map((opts.attributes ?? []).map(a => [a.id, a]))
    for (const req of requiredAttrs) {
      const v = filled.get(req.id)
      if (!v) {
        warnings.push(`Atributo obrigatório '${req.name}' (${req.id}) não preenchido.`)
        continue
      }
      const hasValue = (v.value_id && v.value_id.length > 0) || (v.value_name && v.value_name.length > 0)
      if (!hasValue) {
        warnings.push(`Atributo '${req.name}' está vazio.`)
      }
      if (req.value_max_length && v.value_name && v.value_name.length > req.value_max_length) {
        warnings.push(`Atributo '${req.name}' excede ${req.value_max_length} caracteres.`)
      }
    }

    // Title length pra ML
    if (listing.title.length > 60) {
      warnings.push(`Título tem ${listing.title.length} caracteres — ML aceita máx 60. Será truncado.`)
    }

    // Inclui sempre SELLER_SKU se o produto tiver SKU
    const attributesPayload: Array<{ id: string; value_name?: string; value_id?: string }> = [
      ...(opts.attributes ?? []),
    ]
    if (product.sku && !attributesPayload.find(a => a.id === 'SELLER_SKU')) {
      attributesPayload.push({ id: 'SELLER_SKU', value_name: product.sku })
    }

    // Monta payload final ML
    const mlPayload: Record<string, unknown> = {
      title:               listing.title.slice(0, 60),
      category_id:         categoryId,
      price:               Number(opts.price ?? 0),
      currency_id:         'BRL',
      available_quantity:  Math.max(0, Math.floor(Number(opts.stock ?? 0))),
      buying_mode:         'buy_it_now',
      listing_type_id:     opts.listing_type ?? 'free',
      condition:           opts.condition ?? 'new',
      pictures,
      attributes:          attributesPayload,
      description: {
        plain_text: listing.description,
      },
      // F3 vai colocar status=paused; F1+F2 só mostra
      status: 'paused',
    }
    if (videoPayload) mlPayload.video_id = videoPayload.id

    const ready = warnings.length === 0

    return {
      ready,
      warnings,
      predicted_category: {
        category_id:          categoryId,
        category_name:        categoryName,
        domain_id:            domainId,
        domain_name:          domainName,
        suggested_attributes: suggestedAttrs,
      },
      required_attributes: requiredAttrs,
      ml_payload:          mlPayload,
    }
  }
}
