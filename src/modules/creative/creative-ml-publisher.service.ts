import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { CreativeService, type CreativeListing, type CreativeProduct } from './creative.service'

const ML_BASE = 'https://api.mercadolibre.com'

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
  /** Feature flag: backend permite publicar de fato? Frontend usa
   *  pra mostrar/esconder o botão "Publicar agora". */
  publish_enabled: boolean
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

export interface PublishMlOpts extends PreviewBuildOpts {
  /** UUID gerado pela UI quando abre dialog de confirmação. Mesma key
   *  = mesma publicação (idempotente). */
  idempotency_key: string
}

export interface CreativePublication {
  id:                     string
  organization_id:        string
  listing_id:             string
  product_id:             string
  user_id:                string | null
  marketplace:            'mercado_livre' | 'shopee' | 'amazon' | 'magalu'
  status:                 'pending' | 'publishing' | 'published' | 'failed'
  idempotency_key:        string
  image_ids:              string[]
  video_id:               string | null
  category_id:            string | null
  listing_type:           string | null
  condition:              string | null
  price:                  number | null
  stock:                  number | null
  attributes:             unknown[]
  payload_sent:           Record<string, unknown> | null
  external_id:            string | null
  external_url:           string | null
  external_picture_ids:   string[]
  external_video_id:      string | null
  ml_response:            Record<string, unknown> | null
  last_synced_status:     string | null
  last_synced_at:         string | null
  error_message:          string | null
  published_at:           string | null
  created_at:             string
  updated_at:             string
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
      publish_enabled: this.isPublishEnabled(),
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

  // ════════════════════════════════════════════════════════════════════════
  // PUBLISH (F3 — gated por feature flag)
  // ════════════════════════════════════════════════════════════════════════

  /** Feature flag: só ativa publicação real quando explicitamente liberado.
   *  Default desligado pra evitar publicar acidentalmente em conta de prod. */
  isPublishEnabled(): boolean {
    return process.env.CREATIVE_ML_PUBLISH_ENABLED === 'true'
  }

  /** Publica de fato no ML. Status final do anúncio = `paused` (default
   *  user revisa no ML antes de ativar). Idempotente via idempotency_key. */
  async publishToMl(
    orgId:    string,
    userId:   string,
    listingId: string,
    opts:     PublishMlOpts,
  ): Promise<CreativePublication> {
    if (!this.isPublishEnabled()) {
      throw new ForbiddenException(
        'Publicação real desabilitada. Setar CREATIVE_ML_PUBLISH_ENABLED=true no Railway pra ativar.',
      )
    }
    if (!opts.idempotency_key) {
      throw new BadRequestException('idempotency_key obrigatório')
    }

    // Idempotência: se já tem publication com essa key, retorna ela
    const existing = await this.findByIdempotencyKey(orgId, 'mercado_livre', opts.idempotency_key)
    if (existing) {
      this.logger.log(`[creative.ml.publish] idempotency hit — retornando publication ${existing.id} (status=${existing.status})`)
      return existing
    }

    // Re-valida via buildPreview — se tiver warning, recusa
    const preview = await this.buildPreview(orgId, listingId, opts)
    if (!preview.ready) {
      throw new BadRequestException(
        `Anúncio com pendências — corrija antes de publicar:\n• ${preview.warnings.join('\n• ')}`,
      )
    }

    // Cria row 'pending'
    const { data: created, error: createErr } = await supabaseAdmin
      .from('creative_publications')
      .insert({
        organization_id:  orgId,
        listing_id:       listingId,
        product_id:       (preview.ml_payload.product_id as string) ?? null,
        user_id:          userId,
        marketplace:      'mercado_livre',
        status:           'pending',
        idempotency_key:  opts.idempotency_key,
        image_ids:        opts.image_ids ?? [],
        video_id:         opts.video_id ?? null,
        category_id:      preview.predicted_category.category_id,
        listing_type:     opts.listing_type ?? 'free',
        condition:        opts.condition ?? 'new',
        price:            opts.price,
        stock:            opts.stock,
        attributes:       opts.attributes ?? [],
        payload_sent:     preview.ml_payload,
      })
      .select('*')
      .single()
    if (createErr || !created) {
      // Pode ser race do unique key — tenta achar de novo
      const fallback = await this.findByIdempotencyKey(orgId, 'mercado_livre', opts.idempotency_key)
      if (fallback) return fallback
      throw new BadRequestException(`createPublication: ${createErr?.message ?? 'falhou'}`)
    }

    const pub = created as CreativePublication
    // product_id correto (não vem no payload, busco do listing)
    const listing = await this.creative.getListing(orgId, listingId)
    if (pub.product_id !== listing.product_id) {
      await supabaseAdmin
        .from('creative_publications')
        .update({ product_id: listing.product_id })
        .eq('id', pub.id)
      pub.product_id = listing.product_id
    }

    // Marca publishing
    await this.setPublicationStatus(pub.id, 'publishing')

    try {
      const { token } = await this.ml.getTokenForOrg(orgId)

      // Pictures: passa como source URL — ML baixa sozinho.
      // Não precisa pre-upload separado pra MVP.

      // Video: SKIP nesta sprint. ML video API requer multipart upload + poll
      // status, é um sub-projeto à parte. Listing publica sem vídeo.
      const skippedVideo = !!opts.video_id

      // Monta payload final (já vem em preview.ml_payload, mas ajustes finais aqui)
      const mlBody: Record<string, unknown> = { ...preview.ml_payload }
      delete (mlBody as { product_id?: unknown }).product_id // não vai pro ML
      delete (mlBody as { video_id?: unknown }).video_id     // skipped

      // POST /items — autenticado
      const res = await axios.post<{
        id:         string
        permalink?: string
        status?:    string
        pictures?:  Array<{ id: string; url: string }>
      }>(`${ML_BASE}/items`, mlBody, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 60_000,
      })

      const item = res.data
      const externalPictureIds = (item.pictures ?? [])
        .map(p => p.id)
        .filter(Boolean)

      // Update success
      const { data: updated } = await supabaseAdmin
        .from('creative_publications')
        .update({
          status:                'published',
          external_id:           item.id,
          external_url:          item.permalink ?? null,
          external_picture_ids:  externalPictureIds,
          external_video_id:     null,
          ml_response:           item as unknown as Record<string, unknown>,
          published_at:          new Date().toISOString(),
          updated_at:            new Date().toISOString(),
          error_message:         skippedVideo
            ? 'Vídeo não publicado nesta versão (F3.1 vai adicionar upload de vídeo).'
            : null,
        })
        .eq('id', pub.id)
        .select('*')
        .single()

      this.logger.log(`[creative.ml.publish] ✓ ${item.id} publicado (status: ${item.status ?? '?'})`)
      return (updated as CreativePublication) ?? pub
    } catch (e: unknown) {
      const errPayload = extractMlError(e)
      await supabaseAdmin
        .from('creative_publications')
        .update({
          status:        'failed',
          error_message: errPayload.message,
          ml_response:   errPayload.body,
          updated_at:    new Date().toISOString(),
        })
        .eq('id', pub.id)
      this.logger.error(`[creative.ml.publish] ✗ ${errPayload.message}`)
      throw new HttpException(`ML rejeitou: ${errPayload.message}`, HttpStatus.BAD_GATEWAY)
    }
  }

  async getPublication(orgId: string, id: string): Promise<CreativePublication> {
    const { data, error } = await supabaseAdmin
      .from('creative_publications')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`getPublication: ${error.message}`)
    if (!data)  throw new NotFoundException('publication não encontrada')
    return data as CreativePublication
  }

  async listPublicationsByListing(orgId: string, listingId: string): Promise<CreativePublication[]> {
    await this.creative.getListing(orgId, listingId) // tenant check
    const { data, error } = await supabaseAdmin
      .from('creative_publications')
      .select('*')
      .eq('organization_id', orgId)
      .eq('listing_id', listingId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw new BadRequestException(`listPublicationsByListing: ${error.message}`)
    return (data ?? []) as CreativePublication[]
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async findByIdempotencyKey(
    orgId:           string,
    marketplace:     'mercado_livre' | 'shopee' | 'amazon' | 'magalu',
    idempotencyKey:  string,
  ): Promise<CreativePublication | null> {
    const { data } = await supabaseAdmin
      .from('creative_publications')
      .select('*')
      .eq('organization_id', orgId)
      .eq('marketplace', marketplace)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle()
    return (data as CreativePublication) ?? null
  }

  private async setPublicationStatus(id: string, status: 'publishing' | 'failed' | 'published'): Promise<void> {
    await supabaseAdmin
      .from('creative_publications')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
  }
}

// ── Helpers de erro ──────────────────────────────────────────────────────

function extractMlError(e: unknown): { message: string; body: Record<string, unknown> | null } {
  if (axios.isAxiosError(e)) {
    const ax = e as AxiosError<{
      message?: string
      error?:   string
      cause?:   Array<{ code?: string; message?: string }>
    }>
    const data = ax.response?.data
    const causeMsg = data?.cause?.map(c => c.message).filter(Boolean).join('; ')
    const msg = data?.message ?? data?.error ?? ax.message ?? 'erro desconhecido'
    return {
      message: causeMsg ? `${msg}: ${causeMsg}` : msg,
      body:    (data as unknown as Record<string, unknown>) ?? null,
    }
  }
  return { message: (e as Error).message ?? 'erro desconhecido', body: null }
}
