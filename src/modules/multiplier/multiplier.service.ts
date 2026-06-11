import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { contentKeyFor, CHANNEL_TITLE_LIMITS, CHANNEL_LABELS, ChannelPlatform } from '../../common/channel-map'
import { ShopeeCreativePublisherService } from '../marketplace/shopee-creative/shopee-creative.service'
import { ShopeeDraftListing } from '../marketplace/shopee-creative/shopee-creative.types'
import { TikTokShopService } from '../tiktok-shop/tiktok-shop.service'
import { ProductsService } from '../products/products.service'
import {
  MULTIPLIER_TARGETS, MultiplierTarget, MultiplierPayload, MultiplierDraft, MultiplierCandidate,
} from './multiplier.types'

/** Campos do produto canônico que alimentam a proposta de multiplicação. */
const PRODUCT_FIELDS =
  'id, organization_id, name, sku, price, stock, brand, gtin, description, ' +
  'ai_long_description, ai_short_description, channel_titles, channel_descriptions, ' +
  'ml_title, photo_urls, images, weight_kg, width_cm, length_cm, height_cm, storefront_visible'

interface ProductRow {
  id: string
  organization_id: string | null
  name: string | null
  sku: string | null
  price: number | null
  stock: number | null
  brand: string | null
  gtin: string | null
  description: string | null
  ai_long_description: string | null
  ai_short_description: string | null
  channel_titles: Record<string, string> | null
  channel_descriptions: Record<string, string> | null
  ml_title: string | null
  photo_urls: string[] | null
  images: unknown
  weight_kg: number | null
  width_cm: number | null
  length_cm: number | null
  height_cm: number | null
  storefront_visible: boolean | null
}

interface ListingRow {
  product_id: string
  platform: string
  account_id: string | null
  listing_id: string
  listing_title: string | null
  listing_price: number | null
}

/** Multiplicação de Anúncios — orquestrador (produto canônico → canal destino).
 *  Fluxo: candidatos (cobertura) → draft revisável → publish via publicador
 *  existente do canal. O vínculo em product_listings e a regra central de
 *  estoque acontecem DENTRO dos publicadores — aqui não se toca neles. */
@Injectable()
export class MultiplierService {
  private readonly logger = new Logger(MultiplierService.name)

  constructor(
    private readonly shopeePublisher: ShopeeCreativePublisherService,
    private readonly tiktok:          TikTokShopService,
    private readonly products:        ProductsService,
  ) {}

  // ── Destinos conectados ────────────────────────────────────────────────

  async getTargets(orgId: string): Promise<{
    shopee:      Array<{ shop_id: number; nickname: string | null }>
    tiktok_shop: { connected: boolean }
    storefront:  { connected: boolean }
  }> {
    const [shops, tiktokConn] = await Promise.all([
      this.shopeePublisher.listShops(orgId).catch(() => [] as Array<{ shop_id: number; nickname: string | null }>),
      supabaseAdmin
        .from('tiktok_shop_credentials')
        .select('status')
        .eq('organization_id', orgId)
        .maybeSingle<{ status: string | null }>(),
    ])
    return {
      shopee:      shops,
      tiktok_shop: { connected: tiktokConn.data?.status === 'connected' },
      storefront:  { connected: true },
    }
  }

  // ── Candidatos (produto com anúncio em algum canal e sem anúncio no destino) ──

  async listCandidates(orgId: string, opts: {
    target: MultiplierTarget
    accountId?: string | null
    q?: string | null
    limit?: number
    offset?: number
  }): Promise<{ total: number; items: MultiplierCandidate[] }> {
    this.assertTarget(opts.target)
    const limit  = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)

    const listings = await this.fetchActiveListings(orgId)
    const byProduct = new Map<string, ListingRow[]>()
    for (const l of listings) {
      const arr = byProduct.get(l.product_id) ?? []
      arr.push(l)
      byProduct.set(l.product_id, arr)
    }

    // candidato = tem ≥1 anúncio ativo e NÃO está coberto no destino(+conta)
    const candidateIds: string[] = []
    for (const [pid, ls] of byProduct) {
      const covered = ls.some(l =>
        l.platform === opts.target &&
        (opts.target !== 'shopee' || !opts.accountId || String(l.account_id) === String(opts.accountId)),
      )
      if (!covered) candidateIds.push(pid)
    }
    if (candidateIds.length === 0) return { total: 0, items: [] }

    // dados dos produtos (filtro q aplicado no banco, paginação em memória
    // sobre a lista de candidatos — escala atual: centenas de produtos)
    const rows: ProductRow[] = []
    for (let i = 0; i < candidateIds.length; i += 200) {
      let qb = supabaseAdmin
        .from('products')
        .select(PRODUCT_FIELDS)
        .eq('organization_id', orgId)
        .in('id', candidateIds.slice(i, i + 200))
      if (opts.q?.trim()) qb = qb.or(`name.ilike.%${opts.q.trim()}%,sku.ilike.%${opts.q.trim()}%`)
      const { data, error } = await qb
      if (error) throw new BadRequestException(`listCandidates: ${error.message}`)
      rows.push(...((data ?? []) as unknown as ProductRow[]))
    }

    rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    const page = rows.slice(offset, offset + limit)

    const items: MultiplierCandidate[] = page.map(p => {
      const photos = this.collectImageUrls(p)
      const covered = (byProduct.get(p.id) ?? []).map(l =>
        l.account_id ? `${l.platform}:${l.account_id}` : l.platform,
      )
      return {
        product_id:  p.id,
        name:        p.name ?? '(sem nome)',
        sku:         p.sku,
        price:       p.price,
        stock:       p.stock,
        photo_count: photos.length,
        thumbnail:   photos[0] ?? null,
        covered:     [...new Set(covered)],
        warnings:    this.publishWarnings(opts.target, p, photos),
      }
    })

    return { total: rows.length, items }
  }

  // ── Drafts ─────────────────────────────────────────────────────────────

  async createDraft(orgId: string, userId: string, body: {
    product_id: string
    target_platform: MultiplierTarget
    target_account_id?: string | null
    source_listing_id?: string | null
  }): Promise<MultiplierDraft> {
    this.assertTarget(body.target_platform)
    if (!body.product_id) throw new BadRequestException('product_id obrigatório')

    const product = await this.fetchProduct(orgId, body.product_id)

    // resolve conta destino (Shopee multi-loja)
    let accountId: string | null = body.target_account_id ?? null
    if (body.target_platform === 'shopee' && !accountId) {
      const shops = await this.shopeePublisher.listShops(orgId)
      if (shops.length === 0) throw new BadRequestException('Nenhuma loja Shopee conectada.')
      if (shops.length > 1) {
        throw new BadRequestException('Mais de uma loja Shopee conectada — informe target_account_id (shop_id).')
      }
      accountId = String(shops[0].shop_id)
    }

    // já coberto no destino? não duplica anúncio
    const listings = await this.fetchActiveListings(orgId, body.product_id)
    const dup = listings.find(l =>
      l.platform === body.target_platform &&
      (body.target_platform !== 'shopee' || !accountId || String(l.account_id) === String(accountId)),
    )
    if (dup) {
      throw new BadRequestException(
        `Este produto já tem anúncio ativo em ${CHANNEL_LABELS[body.target_platform as ChannelPlatform]} (${dup.listing_id}).`,
      )
    }

    // draft aberto pro mesmo destino → retorna o existente (idempotente)
    const { data: open } = await supabaseAdmin
      .from('multiplier_drafts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('product_id', body.product_id)
      .eq('target_platform', body.target_platform)
      .in('status', ['draft', 'publishing'])
      .limit(5)
    const sameAccount = (open ?? []).find(d =>
      String((d as { target_account_id: string | null }).target_account_id ?? '') === String(accountId ?? ''))
    if (sameAccount) return sameAccount as unknown as MultiplierDraft

    // conteúdo de origem: anúncio escolhido OU melhor anúncio existente (ML primeiro)
    let source: ListingRow | null = null
    if (body.source_listing_id) {
      source = listings.find(l => l.listing_id === body.source_listing_id) ?? null
      if (!source) throw new BadRequestException('source_listing_id não é um anúncio ativo deste produto.')
    } else {
      source = listings.find(l => l.platform === 'mercadolivre') ?? listings[0] ?? null
    }

    const payload = await this.buildPayload(orgId, body.target_platform, product, source)

    const { data, error } = await supabaseAdmin
      .from('multiplier_drafts')
      .insert({
        organization_id:   orgId,
        product_id:        body.product_id,
        source_platform:   source?.platform ?? null,
        source_listing_id: source?.listing_id ?? null,
        target_platform:   body.target_platform,
        target_account_id: accountId,
        payload,
        status:            'draft',
        created_by:        userId,
      })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`createDraft: ${error.message}`)
    return data as unknown as MultiplierDraft
  }

  async listDrafts(orgId: string, opts: { status?: string | null; limit?: number; offset?: number }): Promise<MultiplierDraft[]> {
    const limit  = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)
    let qb = supabaseAdmin
      .from('multiplier_drafts')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (opts.status?.trim()) qb = qb.eq('status', opts.status.trim())
    const { data, error } = await qb
    if (error) throw new BadRequestException(`listDrafts: ${error.message}`)
    return (data ?? []) as unknown as MultiplierDraft[]
  }

  async updateDraft(orgId: string, draftId: string, patch: Partial<MultiplierPayload>): Promise<MultiplierDraft> {
    const draft = await this.fetchDraft(orgId, draftId)
    if (draft.status !== 'draft' && draft.status !== 'failed') {
      throw new BadRequestException(`Draft em status '${draft.status}' não pode ser editado.`)
    }

    const allowed: Array<keyof MultiplierPayload> = [
      'title', 'description', 'price', 'image_urls', 'sku', 'brand',
      'weight_kg', 'package_dimensions_cm', 'stock', 'category_id',
    ]
    const merged: MultiplierPayload = { ...draft.payload }
    for (const k of allowed) {
      if (patch[k] !== undefined) (merged as unknown as Record<string, unknown>)[k] = patch[k] as unknown
    }
    if (merged.title) {
      merged.title = merged.title.trim().slice(0, CHANNEL_TITLE_LIMITS[draft.target_platform as ChannelPlatform] ?? 255)
    }

    const { data, error } = await supabaseAdmin
      .from('multiplier_drafts')
      .update({ payload: merged, status: 'draft', error_message: null, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', draftId)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateDraft: ${error.message}`)
    return data as unknown as MultiplierDraft
  }

  async discardDraft(orgId: string, draftId: string): Promise<{ ok: true }> {
    const draft = await this.fetchDraft(orgId, draftId)
    if (draft.status === 'publishing') throw new BadRequestException('Draft publicando — aguarde terminar.')
    const { error } = await supabaseAdmin
      .from('multiplier_drafts')
      .update({ status: 'discarded', updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', draftId)
    if (error) throw new BadRequestException(`discardDraft: ${error.message}`)
    return { ok: true }
  }

  // ── Publish (despacho pro publicador do destino) ───────────────────────

  async publishDraft(orgId: string, userId: string, draftId: string): Promise<MultiplierDraft> {
    const draft = await this.fetchDraft(orgId, draftId)
    if (draft.status !== 'draft' && draft.status !== 'failed') {
      throw new BadRequestException(`Draft em status '${draft.status}' não pode ser publicado.`)
    }

    await this.setDraftStatus(orgId, draftId, { status: 'publishing', error_message: null })

    try {
      let externalId: string
      if (draft.target_platform === 'storefront') {
        externalId = await this.publishToStorefront(orgId, draft)
      } else if (draft.target_platform === 'shopee') {
        externalId = await this.publishToShopee(orgId, draft)
      } else if (draft.target_platform === 'tiktok_shop') {
        externalId = await this.publishToTikTok(orgId, draft)
      } else {
        throw new BadRequestException(
          `Destino '${draft.target_platform}' ainda não suportado pelo multiplicador — use o IA Criativo.`,
        )
      }

      await this.setDraftStatus(orgId, draftId, {
        status: 'published', external_id: externalId, published_at: new Date().toISOString(),
      })
      this.logger.log(`[multiplier] publicado draft=${draftId} target=${draft.target_platform} external=${externalId} user=${userId}`)
      return await this.fetchDraft(orgId, draftId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await this.setDraftStatus(orgId, draftId, { status: 'failed', error_message: msg.slice(0, 1000) })
      this.logger.warn(`[multiplier] publish falhou draft=${draftId} target=${draft.target_platform}: ${msg}`)
      throw e instanceof BadRequestException ? e : new BadRequestException(msg)
    }
  }

  private async publishToStorefront(orgId: string, draft: MultiplierDraft): Promise<string> {
    const res = await this.products.setStorefrontVisibility(orgId, [draft.product_id], true)
    if (res.updated === 0) {
      throw new BadRequestException('Produto sem nome ou sem preço — complete o cadastro antes de publicar na loja.')
    }
    return draft.product_id
  }

  private async publishToShopee(orgId: string, draft: MultiplierDraft): Promise<string> {
    const p = draft.payload
    const shopeeDraft: ShopeeDraftListing = {
      shop_id:            Number(draft.target_account_id ?? 0),
      product_id:         draft.product_id,
      catalog_product_id: draft.product_id,
      title:              p.title,
      description:        p.description,
      price:              p.price,
      image_count:        p.image_urls?.length || null,
      image_urls:         p.image_urls?.length ? p.image_urls : null,
      weight_kg:          p.weight_kg,
      package_length_cm:  p.package_dimensions_cm?.length ?? null,
      package_width_cm:   p.package_dimensions_cm?.width ?? null,
      package_height_cm:  p.package_dimensions_cm?.height ?? null,
      brand:              p.brand,
    }
    const res = await this.shopeePublisher.publish(orgId, shopeeDraft)
    if (!res.ok || !res.item_id) {
      throw new BadRequestException(
        `Shopee bloqueou a publicação:\n• ${(res.blockers ?? ['erro desconhecido']).join('\n• ')}`,
      )
    }
    return String(res.item_id)
  }

  private async publishToTikTok(orgId: string, draft: MultiplierDraft): Promise<string> {
    const p = draft.payload
    let categoryId = p.category_id ?? null
    if (!categoryId) {
      const rec = await this.tiktok.recommendCategory(orgId, {
        product_name: p.title, description: p.description ?? undefined,
      })
      categoryId = rec.category_id
    }
    if (!categoryId) {
      throw new BadRequestException(
        'TikTok não recomendou categoria pra este título — edite o draft e informe category_id.',
      )
    }
    if (!p.image_urls?.length) throw new BadRequestException('Produto sem foto — adicione imagens antes de publicar no TikTok.')

    const res = await this.tiktok.publishProduct(orgId, {
      title:                 p.title,
      description:           p.description ?? undefined,
      category_id:           categoryId,
      image_urls:            p.image_urls,
      price:                 p.price ?? 0,
      stock:                 p.stock ?? 0,
      sku:                   p.sku ?? undefined,
      package_weight_kg:     p.weight_kg ?? undefined,
      package_dimensions_cm: p.package_dimensions_cm ?? undefined,
      brand_name:            p.brand ?? undefined,
    })
    if (!res.product_id) throw new BadRequestException('TikTok não retornou product_id.')
    return String(res.product_id)
  }

  // ── Montagem da proposta ───────────────────────────────────────────────

  private async buildPayload(
    orgId: string,
    target: MultiplierTarget,
    product: ProductRow,
    source: ListingRow | null,
  ): Promise<MultiplierPayload> {
    const key = contentKeyFor(target)
    const channelTitle = key ? product.channel_titles?.[key] : null
    const channelDesc  = key ? product.channel_descriptions?.[key] : null

    const rawTitle =
      channelTitle?.trim() ||
      source?.listing_title?.trim() ||
      product.ml_title?.trim() ||
      product.name?.trim() || ''
    const title = rawTitle.slice(0, CHANNEL_TITLE_LIMITS[target as ChannelPlatform] ?? 255)

    const description =
      channelDesc?.trim() ||
      product.ai_long_description?.trim() ||
      product.description?.trim() ||
      product.ai_short_description?.trim() || null

    const price = source?.listing_price ?? product.price ?? null
    const images = this.collectImageUrls(product).slice(0, 9)

    const dims = (product.length_cm && product.width_cm && product.height_cm)
      ? { length: product.length_cm, width: product.width_cm, height: product.height_cm }
      : null

    const payload: MultiplierPayload = {
      title,
      description,
      price: price != null ? Math.round(Number(price) * 100) / 100 : null,
      image_urls: images,
      sku: product.sku,
      brand: product.brand,
      weight_kg: product.weight_kg,
      package_dimensions_cm: dims,
      stock: product.stock,
    }

    // TikTok: já resolve a categoria recomendada no draft (best-effort) pra
    // revisão humana ver/editar antes do publish.
    if (target === 'tiktok_shop' && title) {
      try {
        const rec = await this.tiktok.recommendCategory(orgId, {
          product_name: title, description: description ?? undefined,
        })
        payload.category_id = rec.category_id
      } catch {
        payload.category_id = null
      }
    }

    return payload
  }

  private publishWarnings(target: MultiplierTarget, p: ProductRow, photos: string[]): string[] {
    const w: string[] = []
    if (photos.length === 0) w.push('sem fotos')
    if (!p.price || p.price <= 0) w.push('sem preço')
    if (target === 'tiktok_shop' && !p.sku?.trim()) w.push('sem SKU (anúncio nasce sem vínculo de estoque)')
    if (target === 'shopee') {
      const desc = p.channel_descriptions?.['shopee'] ?? p.ai_long_description ?? p.description ?? ''
      if ((desc ?? '').trim().length < 20) w.push('descrição curta (<20 chars)')
    }
    return w
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private assertTarget(target: string): asserts target is MultiplierTarget {
    if (!MULTIPLIER_TARGETS.includes(target as MultiplierTarget)) {
      throw new BadRequestException(
        `target_platform inválido: '${target}'. Suportados: ${MULTIPLIER_TARGETS.join(', ')} ` +
        '(Mercado Livre como destino: use o IA Criativo).',
      )
    }
  }

  private async fetchProduct(orgId: string, productId: string): Promise<ProductRow> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(PRODUCT_FIELDS)
      .eq('organization_id', orgId)
      .eq('id', productId)
      .maybeSingle()
    if (error) throw new BadRequestException(`fetchProduct: ${error.message}`)
    if (!data) throw new NotFoundException('Produto não encontrado.')
    return data as unknown as ProductRow
  }

  private async fetchDraft(orgId: string, draftId: string): Promise<MultiplierDraft> {
    const { data, error } = await supabaseAdmin
      .from('multiplier_drafts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', draftId)
      .maybeSingle()
    if (error) throw new BadRequestException(`fetchDraft: ${error.message}`)
    if (!data) throw new NotFoundException('Draft não encontrado.')
    return data as unknown as MultiplierDraft
  }

  private async setDraftStatus(orgId: string, draftId: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await supabaseAdmin
      .from('multiplier_drafts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', draftId)
    if (error) throw new BadRequestException(`setDraftStatus: ${error.message}`)
  }

  /** Anúncios ativos da org (opcionalmente de 1 produto), org-scoped via join. */
  private async fetchActiveListings(orgId: string, productId?: string): Promise<ListingRow[]> {
    const out: ListingRow[] = []
    const pageSize = 1000
    for (let from = 0; ; from += pageSize) {
      let qb = supabaseAdmin
        .from('product_listings')
        .select('product_id, platform, account_id, listing_id, listing_title, listing_price, products!inner(organization_id)')
        .eq('products.organization_id', orgId)
        .eq('is_active', true)
        .range(from, from + pageSize - 1)
      if (productId) qb = qb.eq('product_id', productId)
      const { data, error } = await qb
      if (error) throw new BadRequestException(`fetchActiveListings: ${error.message}`)
      const rows = (data ?? []) as unknown as ListingRow[]
      out.push(...rows)
      if (rows.length < pageSize) break
    }
    return out
  }

  /** URLs https de imagem do produto (photo_urls + images jsonb legado). */
  private collectImageUrls(p: ProductRow): string[] {
    const urls: string[] = []
    for (const u of p.photo_urls ?? []) {
      if (typeof u === 'string' && u.startsWith('http')) urls.push(u)
    }
    if (Array.isArray(p.images)) {
      for (const it of p.images as unknown[]) {
        if (typeof it === 'string' && it.startsWith('http')) urls.push(it)
        else if (it && typeof it === 'object') {
          const u = (it as { url?: unknown; secure_url?: unknown }).secure_url ?? (it as { url?: unknown }).url
          if (typeof u === 'string' && u.startsWith('http')) urls.push(u)
        }
      }
    }
    return [...new Set(urls)]
  }
}
