import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { randomUUID } from 'crypto'
import { supabaseAdmin } from '../../common/supabase'
import { composeListingDescription } from '../../common/listing-description'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlShippingCostService, type ShippingCostResult } from '../mercadolivre/ml-shipping-cost.service'
import { CreativeService, type CreativeListing, type CreativeProduct } from './creative.service'
import { LlmService } from '../ai/llm.service'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { ActiveResolverService } from '../active-bridge/active-resolver.service'
import { ShopeeCreativePublisherService } from '../marketplace/shopee-creative/shopee-creative.service'
import { TikTokShopService } from '../tiktok-shop/tiktok-shop.service'

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
  required_attributes: MlAttributeSpec[]
  /** Atributos recomendados (não-obrigatórios) — aceitam "não se aplica". */
  recommended_attributes: MlAttributeSpec[]
  /** Objeto que iria pro POST /items. Frontend mostra como JSON formatado. */
  ml_payload: Record<string, unknown>
}

export interface MlAttributeSpec {
  id:                string
  name:              string
  value_type:        string
  required:          boolean
  value_max_length?: number
  values?:           Array<{ id: string; name: string }>
  hint?:             string
  /** Unidade default (number_unit) — ex: W, cm, g. Usado pra normalizar valores. */
  default_unit?:     string
}

export interface PublishMlOpts extends PreviewBuildOpts {
  /** UUID gerado pela UI quando abre dialog de confirmação. Mesma key
   *  = mesma publicação (idempotente). */
  idempotency_key: string
  /** Conta ML de destino. Omitido = conta resolvida por updated_at (legacy). */
  seller_id?: number
  /** Preço de atacado (B2B) — aplicado pós-publicação. Requer wholesale_min_qty ≥ 2. */
  wholesale_price?: number
  /** Quantidade mínima de compra para o preço de atacado. */
  wholesale_min_qty?: number
}

export interface CreativePublication {
  id:                            string
  organization_id:               string
  listing_id:                    string
  product_id:                    string
  user_id:                       string | null
  seller_id:                     number | null
  marketplace:                   'mercado_livre' | 'shopee' | 'amazon' | 'magalu' | 'tiktok_shop' | 'tiktok' | 'loja_propria'
  status:                        'pending' | 'publishing' | 'published' | 'failed'
  idempotency_key:               string
  image_ids:                     string[]
  video_id:                      string | null
  category_id:                   string | null
  listing_type:                  string | null
  condition:                     string | null
  price:                         number | null
  stock:                         number | null
  attributes:                    unknown[]
  payload_sent:                  Record<string, unknown> | null
  external_id:                   string | null
  external_url:                  string | null
  external_picture_ids:          string[]
  external_video_id:             string | null
  ml_response:                   Record<string, unknown> | null
  last_synced_status:            string | null
  last_synced_at:                string | null
  /** F4 + #8: setado quando sync detecta active → degraded.
   *  Limpado quando user dá ack via dismissDegradation. */
  degraded_at:                   string | null
  degraded_from_status:          string | null
  degraded_to_status:            string | null
  degradation_acknowledged_at:   string | null
  degradation_acknowledged_by:   string | null
  error_message:                 string | null
  published_at:                  string | null
  created_at:                    string
  updated_at:                    string
}

@Injectable()
export class CreativeMlPublisherService {
  private readonly logger = new Logger(CreativeMlPublisherService.name)

  constructor(
    private readonly creative:       CreativeService,
    private readonly ml:             MercadolivreService,
    private readonly shipping:       MlShippingCostService,
    private readonly llm:            LlmService,
    private readonly activeBridge:   ActiveBridgeClient,
    private readonly activeResolver: ActiveResolverService,
    private readonly shopeeCreative: ShopeeCreativePublisherService,
    private readonly tiktok:         TikTokShopService,
  ) {}

  /**
   * Custo do frete grátis pago pelo vendedor pra esse anúncio, dado as
   * dimensões da embalagem e o preço de venda. Usado pelo painel de markup.
   * Resolve a conta ML da org. Retorna `null` quando o ML não responde.
   */
  async getListingShippingCost(
    orgId:     string,
    listingId: string,
    opts: {
      lengthCm: number; widthCm: number; heightCm: number
      weightGrams: number; itemPrice: number; listingTypeId: string
    },
  ): Promise<ShippingCostResult | null> {
    await this.creative.getListing(orgId, listingId)  // tenant check
    const { token, sellerId } = await this.ml.getTokenForOrg(orgId)
    return this.shipping.getFreeShippingCost(token, sellerId, opts)
  }

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

    // Fallback de preço: se não veio preço do match em `products` (produto do
    // fluxo criativo pode não existir no legacy), reusa o preço da ÚLTIMA
    // publicação no Mercado Livre deste listing — o usuário já definiu o preço
    // ali. É o que alimenta o publish do TikTok (que lê sku_suggestion.price).
    if (!skuSuggestion || skuSuggestion.price == null) {
      const { data: lastPub } = await supabaseAdmin
        .from('creative_publications')
        .select('price, stock')
        .eq('organization_id', orgId)
        .eq('listing_id', listingId)
        .eq('marketplace', 'mercado_livre')
        .not('price', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const lp = lastPub as { price: number | null; stock: number | null } | null
      if (lp?.price != null) {
        skuSuggestion = {
          product_id: skuSuggestion?.product_id ?? product.id,
          sku:        skuSuggestion?.sku ?? (product.sku ?? ''),
          price:      lp.price,
          stock:      skuSuggestion?.stock ?? lp.stock,
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

  async getRequiredAttributes(categoryId: string): Promise<MlAttributeSpec[]> {
    const all = await this.ml.getCategoryAttributes(categoryId)
    return all
      // `conditional_required` entra como obrigatório: o ML exige valor real
      // quando a condição é atingida — não aceita "não se aplica".
      .filter(a => a.tags?.required === true
        || a.tags?.catalog_required === true
        || a.tags?.conditional_required === true)
      .map(a => ({
        id:               a.id,
        name:             a.name,
        value_type:       a.value_type,
        required:         true,
        value_max_length: a.value_max_length,
        values:           a.values,
        hint:             a.hint,
        default_unit:     a.default_unit,
      }))
  }

  /** Atributos RECOMENDADOS (não-obrigatórios) visíveis da categoria — os que
   *  aceitam "não se aplica". Exclui ocultos/read-only e os de imagem
   *  (picture_id), que não dá pra preencher por IA. */
  async getRecommendedAttributes(categoryId: string): Promise<MlAttributeSpec[]> {
    const all = await this.ml.getCategoryAttributes(categoryId)
    return all
      .filter(a => {
        const t = a.tags ?? {}
        if (t.hidden || t.read_only) return false
        // obrigatórios e condicionalmente-obrigatórios vão em getRequiredAttributes
        if (t.required || t.catalog_required || t.conditional_required) return false
        if (a.value_type === 'picture_id') return false
        return true
      })
      .map(a => ({
        id:               a.id,
        name:             a.name,
        value_type:       a.value_type,
        required:         false,
        value_max_length: a.value_max_length,
        values:           a.values,
        hint:             a.hint,
        default_unit:     a.default_unit,
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

    // Resolve vídeo (opcional). No preview, registra a intenção; o upload
    // real (com video_id retornado pelo ML) só acontece no publishToMl.
    let videoIntent: { internal_id: string } | null = null
    if (opts.video_id) {
      const video = approved_videos.find(v => v.id === opts.video_id)
      if (!video) {
        warnings.push('Vídeo informado não está aprovado ou não existe.')
      } else {
        videoIntent = { internal_id: video.id }
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

    // Required + recommended attributes
    let requiredAttrs:    MlAttributeSpec[] = []
    let recommendedAttrs: MlAttributeSpec[] = []
    // A categoria usa Mercado Envios quando declara SELLER_PACKAGE_WEIGHT.
    // Esse atributo é `hidden` no /attributes — não cai em required/recommended
    // — mas o ML o EXIGE no POST /items. Detectamos pra validar as medidas.
    let categoryNeedsShipping = false
    if (categoryId) {
      const [req, rec, rawAttrs] = await Promise.all([
        this.getRequiredAttributes(categoryId),
        this.getRecommendedAttributes(categoryId),
        this.ml.getCategoryAttributes(categoryId),
      ])
      requiredAttrs    = req
      recommendedAttrs = rec
      categoryNeedsShipping = rawAttrs.some(a => a.id === 'SELLER_PACKAGE_WEIGHT')
    }

    // Valida attributes preenchidos
    const filled = new Map((opts.attributes ?? []).map(a => [a.id, a]))
    for (const req of requiredAttrs) {
      const v = filled.get(req.id)
      if (!v) {
        warnings.push(`Atributo obrigatório '${req.name}' (${req.id}) não preenchido.`)
        continue
      }
      // value_id "-1" = "não se aplica" — NÃO conta como preenchido para um
      // atributo obrigatório (o ML exige valor real).
      const hasValue = (v.value_id && v.value_id.length > 0 && v.value_id !== '-1')
        || (v.value_name && v.value_name.length > 0)
      if (!hasValue) {
        warnings.push(`Atributo obrigatório '${req.name}' (${req.id}) precisa de um valor — "não se aplica" não é aceito.`)
      }
      if (req.value_max_length && v.value_name && v.value_name.length > req.value_max_length) {
        warnings.push(`Atributo '${req.name}' excede ${req.value_max_length} caracteres.`)
      }
    }

    // Recomendados: lista o que não está preenchido NEM marcado "não se
    // aplica" (value_id "-1" conta como resolvido).
    for (const rec of recommendedAttrs) {
      const v = filled.get(rec.id)
      const resolved = !!((v?.value_id && v.value_id.length > 0) || (v?.value_name && v.value_name.length > 0))
      if (!resolved) {
        warnings.push(`Atributo recomendado '${rec.name}' (${rec.id}) — preencha ou marque "Não se aplica".`)
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

    // Dimensões da embalagem (SELLER_PACKAGE_*) — obrigatórias em categorias
    // com Mercado Envios (ex: iluminação). Lidas de `creative_products.dimensions`,
    // que pode trazer valores nus ("420") ou com unidade ("3 kg").
    //
    // ⚠️ O ML valida o conjunto: se você manda PARTE das medidas (ex: só
    // altura/largura/profundidade, sem peso), ele rejeita com "[seller_package_
    // weight] are all required". Por isso só enviamos quando as 4 estão
    // completas; incompleto + categoria com envio = warning (barra o publish
    // com mensagem clara em vez de deixar o POST /items estourar 502).
    const dims = (product.dimensions ?? {}) as Record<string, unknown>
    const pkgVals: Array<[string, number | null, 'cm' | 'g', string]> = [
      ['SELLER_PACKAGE_HEIGHT', parsePackageDim(dims.altura,       'length'), 'cm', 'altura'],
      ['SELLER_PACKAGE_WIDTH',  parsePackageDim(dims.largura,      'length'), 'cm', 'largura'],
      ['SELLER_PACKAGE_LENGTH', parsePackageDim(dims.profundidade, 'length'), 'cm', 'profundidade'],
      ['SELLER_PACKAGE_WEIGHT', parsePackageDim(dims.peso,         'weight'), 'g',  'peso'],
    ]
    const pkgComplete = pkgVals.every(([, val]) => val != null)
    if (pkgComplete) {
      for (const [id, val, unit] of pkgVals) {
        if (!attributesPayload.find(a => a.id === id)) {
          attributesPayload.push({ id, value_name: `${val} ${unit}` })
        }
      }
    } else if (categoryNeedsShipping) {
      const faltando = pkgVals.filter(([, val]) => val == null).map(([, , , label]) => label)
      warnings.push(
        `Informe as medidas da embalagem (${faltando.join(', ')}) no painel de precificação — ` +
        `o Mercado Livre exige largura, altura, profundidade e peso para calcular o frete.`,
      )
    }

    // Normaliza atributos number_unit: valor nu ("15") sem unidade →
    // "15 W" (default_unit da categoria). Sem isso o ML rejeita ("unit is
    // not valid").
    const specById = new Map<string, MlAttributeSpec>()
    for (const s of [...requiredAttrs, ...recommendedAttrs]) specById.set(s.id, s)
    for (const a of attributesPayload) {
      const spec = specById.get(a.id)
      if (spec?.value_type === 'number_unit' && spec.default_unit
          && a.value_name && /^[\d.,]+$/.test(a.value_name.trim())) {
        a.value_name = `${a.value_name.trim()} ${spec.default_unit}`
      }
    }

    // Monta payload final ML.
    // `family_name`: nome da família do produto — obrigatório em algumas
    // categorias (ex: iluminação). O ML valida que o `title` seja consistente
    // com o `family_name` (o título precisa começar pelo family_name) — usar
    // o próprio título como family_name garante a consistência. Categorias
    // que não exigem simplesmente ignoram o campo.
    const mlTitle = listing.title.slice(0, 60)
    const mlPayload: Record<string, unknown> = {
      title:               mlTitle,
      family_name:         mlTitle,
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
        // ML não tem campo de destaques/FAQ → junta tudo na descrição.
        plain_text: composeListingDescription(listing.description, listing.bullets, listing.faq),
      },
      // F3 vai colocar status=paused; F1+F2 só mostra
      status: 'paused',
    }
    if (videoIntent) {
      // Placeholder no preview — caller deve saber que o video_id real
      // será atribuído após upload pro ML em publishToMl.
      mlPayload.video_id = `<será atribuído após upload — creative_video=${videoIntent.internal_id}>`
    }

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
      required_attributes:    requiredAttrs,
      recommended_attributes: recommendedAttrs,
      ml_payload:             mlPayload,
    }
  }

  /**
   * Sugere valores para os atributos da categoria via IA, a partir dos dados
   * do produto e do anúncio. Atributos recomendados que a IA não consegue
   * determinar voltam como "não se aplica" (value_id "-1"). Atributos
   * obrigatórios nunca recebem "não se aplica" — ficam pro usuário preencher.
   */
  async suggestMlAttributes(
    orgId:      string,
    listingId:  string,
    categoryId?: string,
  ): Promise<Array<{ id: string; value_id?: string; value_name?: string; not_applicable: boolean }>> {
    const ctx = await this.getPublishContext(orgId, listingId)
    const { listing, product } = ctx

    let catId = categoryId?.trim() || null
    if (!catId) {
      const predicted = await this.predictCategoryFromTitle(listing.title)
      catId = predicted.category_id
    }
    if (!catId) return []

    const [required, recommended] = await Promise.all([
      this.getRequiredAttributes(catId),
      this.getRecommendedAttributes(catId),
    ])
    const allAttrs = [...required, ...recommended]
    if (allAttrs.length === 0) return []
    const requiredIds = new Set(required.map(a => a.id))
    const byId = new Map(allAttrs.map(a => [a.id, a]))

    const attrLines = allAttrs.map(a => {
      const opts = (a.values ?? []).map(v => v.name).filter(Boolean)
      let spec: string
      if (opts.length)                         spec = `escolha UMA opção exata: ${opts.slice(0, 60).join(' | ')}`
      else if (a.value_type === 'boolean')     spec = 'responda "Sim" ou "Não"'
      else if (a.value_type === 'number_unit') spec = 'número com unidade (ex: "40 W", "30 cm")'
      else if (a.value_type === 'number')      spec = 'número'
      else                                     spec = 'texto curto'
      return `- ${a.id} ("${a.name}") — ${spec}`
    }).join('\n')

    const userPrompt = [
      'Você preenche a ficha técnica de um anúncio do Mercado Livre.',
      '',
      'PRODUTO:',
      `- Nome: ${product.name}`,
      `- Marca: ${product.brand ?? '—'}`,
      `- Categoria (texto livre): ${product.category ?? '—'}`,
      `- Cor: ${product.color ?? '—'}`,
      `- Material: ${product.material ?? '—'}`,
      `- Diferenciais: ${(product.differentials ?? []).join('; ') || '—'}`,
      `- Dimensões: ${JSON.stringify(product.dimensions ?? {})}`,
      `- Título do anúncio: ${listing.title}`,
      `- Descrição: ${(listing.description ?? '').slice(0, 2000)}`,
      '',
      'ATRIBUTOS A PREENCHER:',
      attrLines,
      '',
      'REGRAS:',
      '- Preencha apenas o que der pra deduzir COM CONFIANÇA dos dados do produto.',
      '- Para atributos com opções, use EXATAMENTE uma das opções listadas.',
      '- Se não der pra determinar, devolva {"id":"X","not_applicable":true}.',
      '- NUNCA invente valores.',
      '',
      'Responda só JSON: {"attributes":[{"id":"X","value":"Y"}|{"id":"X","not_applicable":true}]}',
    ].join('\n')

    const out = await this.llm.generateText({
      orgId,
      feature:    'creative_listing',
      userPrompt,
      jsonMode:   true,
      maxTokens:  2000,
      creative:   { productId: product.id, operation: 'ml_attributes_suggest' },
    })

    let parsed: { attributes?: Array<{ id?: string; value?: string; not_applicable?: boolean }> }
    try { parsed = JSON.parse(out.text) } catch { return [] }
    const items = Array.isArray(parsed?.attributes) ? parsed.attributes : []

    const norm = (s: string) => s.toLowerCase().trim()
    const result: Array<{ id: string; value_id?: string; value_name?: string; not_applicable: boolean }> = []
    for (const it of items) {
      const id = String(it?.id ?? '').trim()
      const attr = byId.get(id)
      if (!attr) continue
      const isRequired = requiredIds.has(id)
      const raw = it?.value == null ? '' : String(it.value).trim()

      if (it?.not_applicable || !raw) {
        // obrigatório nunca vai como "não se aplica"
        if (!isRequired) result.push({ id, value_id: '-1', not_applicable: true })
        continue
      }
      if (attr.values && attr.values.length > 0) {
        const opt = attr.values.find(o => norm(o.name) === norm(raw))
        if (opt)            result.push({ id, value_id: opt.id, value_name: opt.name, not_applicable: false })
        else if (!isRequired) result.push({ id, value_id: '-1', not_applicable: true })
        // obrigatório sem match → deixa pro usuário
      } else {
        result.push({ id, value_name: raw, not_applicable: false })
      }
    }
    return result
  }

  // ════════════════════════════════════════════════════════════════════════
  // PUBLISH (F3 — gated por feature flag)
  // ════════════════════════════════════════════════════════════════════════

  /** Feature flag: só ativa publicação real quando explicitamente liberado.
   *  Default desligado pra evitar publicar acidentalmente em conta de prod. */
  isPublishEnabled(): boolean {
    return process.env.CREATIVE_ML_PUBLISH_ENABLED === 'true'
  }

  /** F3.1 — upload de vídeo pro ML.
   *
   *  ML video API mudou várias vezes; current state (2024+):
   *  - POST /videos com multipart `file` → retorna { id, status }
   *  - id é usado em items.video_id
   *
   *  Como o status real da API varia por região/conta, fazemos
   *  best-effort: tenta upload, se falhar retorna null e o caller
   *  publica sem vídeo (não bloqueia). */
  async uploadVideoToMl(
    orgId:      string,
    videoStoragePath: string,
    sellerId?:  number,
  ): Promise<{ videoId: string } | null> {
    try {
      const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

      // Baixa do bucket creative
      const { data: blob, error: dlErr } = await supabaseAdmin
        .storage
        .from('creative')
        .download(videoStoragePath)
      if (dlErr || !blob) {
        this.logger.warn(`[ml.video] download falhou: ${dlErr?.message}`)
        return null
      }
      const buffer = Buffer.from(await blob.arrayBuffer())

      // Multipart upload — usa form-data lib (já dep do projeto)
      const FormData = (await import('form-data')).default
      const form = new FormData()
      form.append('file', buffer, {
        filename:    'creative.mp4',
        contentType: 'video/mp4',
      })

      const res = await axios.post<{
        id?:      string
        status?:  string
        message?: string
      }>(`${ML_BASE}/videos`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${token}`,
        },
        timeout: 120_000,
        maxContentLength: 200 * 1024 * 1024,
        maxBodyLength:    200 * 1024 * 1024,
      })

      if (!res.data?.id) {
        this.logger.warn(`[ml.video] response sem id: ${JSON.stringify(res.data)}`)
        return null
      }
      this.logger.log(`[ml.video] ✓ upload ${res.data.id} (status=${res.data.status ?? '?'})`)
      return { videoId: res.data.id }
    } catch (e: unknown) {
      const err = extractMlError(e)
      this.logger.warn(`[ml.video] upload falhou — publicação seguirá sem vídeo: ${err.message}`)
      return null
    }
  }

  /**
   * POST /items com fallback de título. Categorias de catálogo/família (ex:
   * iluminação) GERAM o título a partir do `family_name` e rejeitam um
   * `title` no corpo (`invalid_fields [title]`). Quando isso acontece,
   * reenvia sem o campo `title` — o `family_name` (que carrega o título
   * otimizado) vira a base do título gerado pelo ML.
   */
  private async postItemToMl(
    token:  string,
    mlBody: Record<string, unknown>,
  ): Promise<{ id: string; permalink?: string; status?: string; pictures?: Array<{ id: string; url: string }> }> {
    const cfg = {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 60_000,
    }
    try {
      const res = await axios.post(`${ML_BASE}/items`, mlBody, cfg)
      return res.data
    } catch (e: unknown) {
      if (isTitleFieldRejected(e) && 'title' in mlBody) {
        this.logger.log('[creative.ml.publish] categoria gera o título — reenviando sem `title`')
        const retry: Record<string, unknown> = { ...mlBody }
        delete retry.title
        const res = await axios.post(`${ML_BASE}/items`, retry, cfg)
        return res.data
      }
      throw e
    }
  }

  /**
   * Define o preço de atacado (preço por quantidade B2B) de um item já
   * publicado: `POST /items/{id}/prices/standard/quantity`. Mantém o preço
   * `standard` atual e adiciona uma faixa de atacado a partir de `minQty`
   * unidades. Só funciona para sellers habilitados a B2B (tag `business`).
   */
  private async setItemWholesalePrice(
    token:  string,
    itemId: string,
    opts:   { price: number; minQty: number },
  ): Promise<void> {
    const cfg = {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 20_000,
    }
    // Preço standard atual (sem min_purchase_unit) — mantido na tabela.
    const { data: cur } = await axios.get<{
      prices?: Array<{ id: string; type: string; conditions?: { min_purchase_unit?: number } }>
    }>(`${ML_BASE}/items/${itemId}/prices`, cfg)
    const standard = (cur?.prices ?? []).find(
      p => p.type === 'standard' && !p.conditions?.min_purchase_unit,
    )
    const body = {
      prices: [
        ...(standard ? [{ id: standard.id }] : []),
        {
          amount:      opts.price,
          currency_id: 'BRL',
          conditions: {
            context_restrictions: ['channel_marketplace', 'user_type_business'],
            min_purchase_unit:    opts.minQty,
          },
        },
      ],
    }
    await axios.post(`${ML_BASE}/items/${itemId}/prices/standard/quantity`, body, cfg)
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

    // product_id (creative_products) — vem do listing, NÃO do ml_payload.
    // Resolvido ANTES do insert porque a coluna é NOT NULL.
    const listing = await this.creative.getListing(orgId, listingId)

    // Cria row 'pending'
    const { data: created, error: createErr } = await supabaseAdmin
      .from('creative_publications')
      .insert({
        organization_id:  orgId,
        listing_id:       listingId,
        product_id:       listing.product_id,
        user_id:          userId,
        seller_id:        opts.seller_id ?? null,
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

    // Marca publishing
    await this.setPublicationStatus(pub.id, 'publishing')

    try {
      const { token } = await this.ml.getTokenForOrg(orgId, opts.seller_id)

      // Pictures: passa como source URL — ML baixa sozinho.
      // Não precisa pre-upload separado pra MVP.

      // Video: F3.1 — best-effort upload pro ML
      let externalVideoId: string | null = null
      let videoSkipReason: string | null = null
      if (opts.video_id) {
        const { data: vidRow } = await supabaseAdmin
          .from('creative_videos')
          .select('storage_path, status')
          .eq('id', opts.video_id)
          .eq('organization_id', orgId)
          .maybeSingle()
        const vid = vidRow as { storage_path: string | null; status: string } | null
        if (!vid?.storage_path) {
          videoSkipReason = 'video sem storage_path'
        } else if (vid.status !== 'approved') {
          videoSkipReason = `video status='${vid.status}' (deve ser 'approved')`
        } else {
          const upload = await this.uploadVideoToMl(orgId, vid.storage_path, opts.seller_id)
          if (upload) {
            externalVideoId = upload.videoId
          } else {
            videoSkipReason = 'upload pro ML falhou — publicação seguirá sem vídeo'
          }
        }
      }

      // Monta payload final (já vem em preview.ml_payload, mas ajustes finais aqui)
      const mlBody: Record<string, unknown> = { ...preview.ml_payload }
      delete (mlBody as { product_id?: unknown }).product_id // não vai pro ML
      if (externalVideoId) {
        mlBody.video_id = externalVideoId
      } else {
        delete (mlBody as { video_id?: unknown }).video_id
      }

      // POST /items — autenticado (com fallback de título)
      const item = await this.postItemToMl(token, mlBody)
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
          external_video_id:     externalVideoId,
          ml_response:           item as unknown as Record<string, unknown>,
          published_at:          new Date().toISOString(),
          updated_at:            new Date().toISOString(),
          error_message:         videoSkipReason ? `Vídeo não incluído: ${videoSkipReason}` : null,
        })
        .eq('id', pub.id)
        .select('*')
        .single()

      this.logger.log(`[creative.ml.publish] ✓ ${item.id} publicado (status: ${item.status ?? '?'})`)

      // Pós-publicação: preço de atacado (preço por quantidade B2B).
      // Fail-isolated — o anúncio já está publicado; se falhar, registra o
      // motivo e o vendedor pode configurar manualmente no ML.
      if (opts.wholesale_price && opts.wholesale_min_qty && opts.wholesale_min_qty >= 2) {
        try {
          await this.setItemWholesalePrice(token, item.id, {
            price:  opts.wholesale_price,
            minQty: Math.floor(opts.wholesale_min_qty),
          })
          this.logger.log(`[creative.ml.publish] ✓ preço de atacado ${item.id}: R$${opts.wholesale_price} (mín ${opts.wholesale_min_qty}un)`)
        } catch (e) {
          const err = extractMlError(e)
          this.logger.warn(`[creative.ml.publish] preço de atacado falhou ${item.id}: ${err.message}`)
          await supabaseAdmin
            .from('creative_publications')
            .update({ error_message: `Preço de atacado não aplicado: ${err.message}`, updated_at: new Date().toISOString() })
            .eq('id', pub.id)
        }
      }

      // Pós-publicação: propaga os dados do anúncio de volta pro produto do
      // catálogo vinculado (título ML, descrição, fotos). Fail-isolated — um
      // erro aqui não desfaz nem invalida a publicação.
      try {
        const creativeProduct = await this.creative.getProduct(orgId, listing.product_id)
        await this.syncCatalogProductAfterPublish(orgId, creativeProduct, listing, item)
      } catch (e) {
        this.logger.warn(`[creative.ml.publish] sync catálogo pós-publish falhou: ${(e as Error).message}`)
      }

      // Pós-publicação: avança o card do funil "Anúncios ML" no Active CRM
      // pra a etapa "Incluir Campanha" e seta o botão de atalho. Fail-isolated.
      try {
        const creativeProduct = await this.creative.getProduct(orgId, listing.product_id)
        await this.advanceActiveCardAfterPublish(orgId, creativeProduct.product_id)
      } catch (e) {
        this.logger.warn(`[creative.ml.publish] move-card Active pós-publish falhou: ${(e as Error).message}`)
      }

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

  /**
   * Propaga os dados do anúncio publicado de volta pro produto do catálogo
   * (`products`) vinculado — fecha o ciclo: o que foi pro ML vira a verdade
   * do catálogo. Só roda quando o creative_product tem `product_id`.
   *
   * Sincroniza: título ML, descrição e fotos (URLs públicas do próprio ML,
   * que são permanentes). Não desvincula nem cria vínculo aqui — o vínculo
   * já nasce no fluxo de Novo Anúncio a partir do catálogo.
   */
  private async syncCatalogProductAfterPublish(
    orgId:           string,
    creativeProduct: { id: string; product_id: string | null },
    listing:         { title: string; description: string; bullets?: string[]; faq?: Array<{ q: string; a: string }> },
    mlItem:          { pictures?: Array<{ url?: string; secure_url?: string }> },
  ): Promise<void> {
    const catalogId = creativeProduct.product_id
    if (!catalogId) {
      this.logger.log(`[creative.ml.publish] anúncio sem vínculo de catálogo — sync pulado`)
      return
    }

    const photoUrls = (mlItem.pictures ?? [])
      .map(p => p.secure_url ?? p.url)
      .filter((u): u is string => !!u)

    const patch: Record<string, unknown> = {
      ml_title:   listing.title,
      updated_at: new Date().toISOString(),
    }
    // Descrição fica LIMPA no catálogo — a Loja própria tem seções próprias de
    // destaques/FAQ, que sincronizamos como CAMPOS (não na descrição) pra não
    // duplicar na vitrine.
    if (listing.description?.trim())      patch.description = listing.description
    if (photoUrls.length > 0)            patch.photo_urls  = photoUrls
    if (Array.isArray(listing.bullets))  patch.bullets     = listing.bullets
    if (Array.isArray(listing.faq))      patch.faq         = listing.faq

    const { error } = await supabaseAdmin
      .from('products')
      .update(patch)
      .eq('id', catalogId)
      .eq('organization_id', orgId)
    if (error) {
      this.logger.warn(`[creative.ml.publish] sync catálogo ${catalogId} falhou: ${error.message}`)
    } else {
      this.logger.log(`[creative.ml.publish] catálogo ${catalogId} sincronizado — título + ${photoUrls.length} foto(s) + ${(listing.bullets?.length ?? 0)} destaques + ${(listing.faq?.length ?? 0)} FAQ`)
    }
  }

  /**
   * Avança o card do anúncio no funil "Anúncios ML" do Active CRM pra a
   * etapa "Incluir Campanha" após a publicação + sync, e coloca o botão
   * de atalho pras campanhas ML.
   *
   * O card é o mesmo criado pelo dispatch de cadastro (Operação de
   * Cadastro → card no Active): achamos o deal vinculado via
   * `product_operator_assignments`. Se o anúncio não veio de um card de
   * cadastro (publicado direto no IA Criativo), não há card pra mover —
   * no-op silencioso.
   */
  private async advanceActiveCardAfterPublish(
    orgId:            string,
    catalogProductId: string | null,
  ): Promise<void> {
    if (!catalogProductId) return
    if (!this.activeBridge.isConfigured()) return

    const dealId = await this.activeResolver.findCardDealForProduct(orgId, catalogProductId)
    if (!dealId) {
      this.logger.log(`[creative.ml.publish] anúncio sem card de cadastro no Active — move-card pulado`)
      return
    }

    const baseUrl = (process.env.FRONTEND_PUBLIC_URL ?? 'https://eclick.app.br').replace(/\/+$/, '')
    const res = await this.activeBridge.moveCard({
      deal_id:       dealId,
      to_stage_name: 'Incluir Campanha',
      action_link: {
        label: 'Incluir em campanha',
        url:   `${baseUrl}/dashboard/ml-campaigns`,
      },
    })
    this.logger.log(
      `[creative.ml.publish] move-card Active deal=${dealId} → Incluir Campanha ` +
      `(found=${res.found} moved=${res.moved}${res.reason ? ` reason=${res.reason}` : ''})`,
    )
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

  // ════════════════════════════════════════════════════════════════════════
  // SYNC (F4 — pollea ML pra atualizar status)
  // ════════════════════════════════════════════════════════════════════════

  /** Sincroniza UMA publication: GET /items/{external_id} -> atualiza
   *  last_synced_status + last_synced_at. Idempotente. */
  async syncPublicationStatus(orgId: string, publicationId: string): Promise<CreativePublication> {
    const pub = await this.getPublication(orgId, publicationId)
    if (pub.status !== 'published') {
      throw new BadRequestException(`Só publications 'published' podem ser sincronizadas (atual: ${pub.status})`)
    }
    if (!pub.external_id) {
      throw new BadRequestException('publication sem external_id')
    }

    // Cross-plataforma: Shopee/TikTok/Loja NÃO podem bater na API do ML — o
    // external_id não é um item ML (= "resource not found"). Cada plataforma
    // confirma o próprio status; o sync NUNCA quebra (soft-fallback).
    if (pub.marketplace !== 'mercado_livre') {
      return this.syncNonMlStatus(orgId, pub)
    }

    const { token } = await this.ml.getTokenForOrg(orgId, pub.seller_id ?? undefined)

    let mlStatus: string | null = null
    try {
      const res = await axios.get<{
        id: string; status?: string; permalink?: string; sold_quantity?: number;
        available_quantity?: number; health?: number;
      }>(`${ML_BASE}/items/${encodeURIComponent(pub.external_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { attributes: 'id,status,permalink,sold_quantity,available_quantity,health' },
        timeout: 15_000,
      })
      mlStatus = res.data.status ?? null

      // Detecta degradação: estava active, agora está em estado problemático.
      // Marca degraded_at SE não havia degradação previa (não-ack).
      const DEGRADED_STATUSES = ['inactive', 'closed', 'under_review', 'payment_required']
      const previousStatus = pub.last_synced_status
      const wasActive      = previousStatus === 'active'
      const isDegraded     = mlStatus !== null && DEGRADED_STATUSES.includes(mlStatus)
      const newDegradation = wasActive && isDegraded && !pub.degraded_at
      // Se voltou pra active depois de degraded, limpa o flag (acknowledged auto)
      const recovered      = pub.degraded_at && !pub.degradation_acknowledged_at && mlStatus === 'active'

      const update: Record<string, unknown> = {
        last_synced_status: mlStatus,
        last_synced_at:     new Date().toISOString(),
        external_url:       res.data.permalink ?? pub.external_url,
        updated_at:         new Date().toISOString(),
      }
      if (newDegradation) {
        update.degraded_at          = new Date().toISOString()
        update.degraded_from_status = previousStatus
        update.degraded_to_status   = mlStatus
        this.logger.warn(`[creative.ml.sync] DEGRADAÇÃO detectada: ${pub.external_id} ${previousStatus} → ${mlStatus}`)
      } else if (recovered) {
        update.degraded_at                 = null
        update.degraded_from_status        = null
        update.degraded_to_status          = null
        update.degradation_acknowledged_at = null
        update.degradation_acknowledged_by = null
        this.logger.log(`[creative.ml.sync] recuperação: ${pub.external_id} voltou pra active`)
      }

      const { data: updated } = await supabaseAdmin
        .from('creative_publications')
        .update(update)
        .eq('id', pub.id)
        .select('*')
        .single()
      return (updated as CreativePublication) ?? pub
    } catch (e: unknown) {
      const err = extractMlError(e)
      this.logger.warn(`[creative.ml.sync] ${pub.external_id}: ${err.message}`)
      // Não muda status='published' — só registra falha de sync
      await supabaseAdmin
        .from('creative_publications')
        .update({
          last_synced_at: new Date().toISOString(),
          updated_at:     new Date().toISOString(),
        })
        .eq('id', pub.id)
      throw new HttpException(`Sync falhou: ${err.message}`, HttpStatus.BAD_GATEWAY)
    }
  }

  /** Sync de confirmação para plataformas NÃO-ML (Shopee/TikTok/Loja própria).
   *  Diferente do ML, NUNCA lança: em qualquer falha (token expirado, escopo,
   *  API fora) só carimba last_synced_at e preserva o status anterior — não
   *  inventa "ativo". Quando consegue, grava o status real normalizado pro
   *  vocabulário comum (active/paused/closed/under_review/inactive). */
  private async syncNonMlStatus(orgId: string, pub: CreativePublication): Promise<CreativePublication> {
    let normalized: string | null = null
    try {
      if (pub.marketplace === 'shopee') {
        normalized = (await this.shopeeCreative.syncListingStatus(orgId, pub.external_id!)).normalized
      } else if (pub.marketplace === 'tiktok_shop' || pub.marketplace === 'tiktok') {
        normalized = (await this.tiktok.getListingStatus(orgId, pub.external_id!)).normalized
      } else if (pub.marketplace === 'loja_propria') {
        // Loja própria: o "status" é a visibilidade na vitrine (local, sem API).
        const { data } = await supabaseAdmin
          .from('products')
          .select('storefront_visible')
          .eq('id', pub.external_id!)
          .maybeSingle<{ storefront_visible: boolean | null }>()
        normalized = data ? (data.storefront_visible ? 'active' : 'paused') : null
      }
    } catch (e: unknown) {
      this.logger.warn(`[creative.sync.${pub.marketplace}] ${pub.external_id}: ${(e as Error).message}`)
    }

    const update: Record<string, unknown> = {
      last_synced_at: new Date().toISOString(),
      updated_at:     new Date().toISOString(),
    }
    if (normalized) update.last_synced_status = normalized

    const { data: updated } = await supabaseAdmin
      .from('creative_publications')
      .update(update)
      .eq('id', pub.id)
      .select('*')
      .single()
    return (updated as CreativePublication) ?? pub
  }

  /** Lista publications atualmente degradadas (não-ack) — usado pela UI
   *  pra mostrar painel de alertas / dashboard. */
  async listDegradedPublications(orgId: string): Promise<CreativePublication[]> {
    const { data, error } = await supabaseAdmin
      .from('creative_publications')
      .select('*')
      .eq('organization_id', orgId)
      .not('degraded_at', 'is', null)
      .is('degradation_acknowledged_at', null)
      .order('degraded_at', { ascending: false })
      .limit(100)
    if (error) throw new BadRequestException(`listDegradedPublications: ${error.message}`)
    return (data ?? []) as CreativePublication[]
  }

  /** Marca a degradação como reconhecida (user clicou dismiss/resolveu). */
  async acknowledgeDegradation(orgId: string, publicationId: string, userId: string): Promise<CreativePublication> {
    const pub = await this.getPublication(orgId, publicationId)
    if (!pub.degraded_at) {
      throw new BadRequestException('publication não está degradada')
    }
    const { data, error } = await supabaseAdmin
      .from('creative_publications')
      .update({
        degradation_acknowledged_at: new Date().toISOString(),
        degradation_acknowledged_by: userId,
        updated_at:                  new Date().toISOString(),
      })
      .eq('id', pub.id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`acknowledgeDegradation: ${error.message}`)
    return data as CreativePublication
  }

  /** Lista publications que precisam ser re-sincronizadas (status='published' +
   *  last_synced_at antigo ou nulo). Usado pelo worker. */
  async listPublicationsForSync(maxItems = 20, staleMinutes = 30): Promise<CreativePublication[]> {
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString()
    const { data } = await supabaseAdmin
      .from('creative_publications')
      .select('*')
      .eq('status', 'published')
      .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff}`)
      .order('last_synced_at', { ascending: true, nullsFirst: true })
      .limit(maxItems)
    return (data ?? []) as CreativePublication[]
  }

  /** Envia o anúncio pra Loja própria (vitrine): resolve o produto de catálogo
   *  (vínculo direto OU match de SKU), sincroniza descrição + destaques + FAQ no
   *  produto e o torna visível na loja. A vitrine tem seções próprias de
   *  bullets/FAQ, então sincronizamos como CAMPOS (não na descrição). */
  async sendToStorefront(orgId: string, listingId: string): Promise<{ product_id: string }> {
    const listing = await this.creative.getListing(orgId, listingId)
    const product = await this.creative.getProduct(orgId, listing.product_id)
    let catalogId = product.product_id
    if (!catalogId && product.sku) {
      const { data: m } = await supabaseAdmin
        .from('products')
        .select('id')
        .eq('organization_id', orgId)
        .eq('sku', product.sku)
        .limit(1)
        .maybeSingle<{ id: string }>()
      catalogId = m?.id ?? null
    }
    if (!catalogId) {
      throw new BadRequestException('Este anúncio não está vinculado a um produto do catálogo (nem por SKU). Cadastre/vincule o produto no catálogo antes de enviar pra Loja.')
    }
    const { error } = await supabaseAdmin
      .from('products')
      .update({
        description:        listing.description,
        bullets:           listing.bullets,
        faq:               listing.faq,
        storefront_visible: true,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', catalogId)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Falha ao enviar pra Loja: ${error.message}`)

    // Registra a Loja como "publicação" (NÃO-FATAL, sem duplicar) pra aparecer
    // na lista "Publicações desse anúncio" junto com ML/Shopee/TikTok.
    try {
      const { data: existing } = await supabaseAdmin
        .from('creative_publications')
        .select('id')
        .eq('organization_id', orgId)
        .eq('listing_id', listingId)
        .eq('marketplace', 'loja_propria')
        .limit(1)
        .maybeSingle<{ id: string }>()
      if (!existing) {
        await supabaseAdmin.from('creative_publications').insert({
          organization_id: orgId,
          listing_id:      listingId,
          product_id:      listing.product_id,
          marketplace:     'loja_propria',
          status:          'published',
          idempotency_key: randomUUID(),
          external_id:     catalogId,
          published_at:    new Date().toISOString(),
        })
      }
    } catch (e) {
      this.logger.warn(`[creative.storefront] registro creative_publications (loja) falhou: ${(e as Error)?.message}`)
    }

    this.logger.log(`[creative.storefront] listing=${listingId} → produto ${catalogId} enviado pra Loja (desc+bullets+faq+visible)`)
    return { product_id: catalogId }
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

/**
 * Lê uma medida de `creative_products.dimensions` (string que pode vir nua —
 * "420" — ou com unidade — "3 kg", "0.4 m") e devolve o valor inteiro na
 * unidade canônica do ML: cm para comprimento, g para peso. Valor nu assume
 * a unidade canônica (cm / g).
 */
function parsePackageDim(raw: unknown, kind: 'length' | 'weight'): number | null {
  const str = String(raw ?? '').trim().toLowerCase()
  const m = str.match(/^([\d.,]+)\s*([a-z"]*)$/)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2]
  if (kind === 'length') {
    const cm = unit === 'm' ? n * 100 : unit === 'mm' ? n / 10 : n  // cm / vazio
    return Math.round(cm)
  }
  const g = unit === 'kg' ? n * 1000 : unit === 'mg' ? n / 1000 : n  // g / vazio
  return Math.round(g)
}

/** True quando o ML rejeitou o campo `title` (categoria gera o título). */
function isTitleFieldRejected(e: unknown): boolean {
  if (!axios.isAxiosError(e)) return false
  const data = e.response?.data as
    | { error?: string; message?: string; cause?: Array<{ message?: string }> }
    | undefined
  if (!data) return false
  const text = [
    data.error ?? '',
    data.message ?? '',
    ...(data.cause ?? []).map(c => c.message ?? ''),
  ].join(' ').toLowerCase()
  return text.includes('[title]') && text.includes('invalid')
}

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
    // `message` costuma ser genérico ("body.invalid_fields") enquanto `error`
    // traz o detalhe útil ("The fields [title] are invalid…"). Junta os dois.
    const detail = causeMsg || (data?.error && data.error !== msg ? data.error : '')
    return {
      message: detail ? `${msg}: ${detail}` : msg,
      body:    (data as unknown as Record<string, unknown>) ?? null,
    }
  }
  return { message: (e as Error).message ?? 'erro desconhecido', body: null }
}
