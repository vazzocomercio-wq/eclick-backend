import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MetaCatalogService } from './meta-catalog.service'
import type {
  SocialCommerceChannel,
  SocialCommerceChannelRow,
  SocialCommerceProductRow,
  ProductSyncStatus,
  MetaProductData,
} from './social-commerce.types'

interface ProductForSync {
  id:                    string
  organization_id:       string
  name:                  string
  brand:                 string | null
  category:              string | null
  price:                 number | null
  stock:                 number | null
  description:           string | null
  ai_short_description:  string | null
  photo_urls:            string[] | null
  channel_titles:        Record<string, string> | null
  channel_descriptions:  Record<string, string> | null
  gtin:                  string | null
  condition:             string | null
  ml_permalink:          string | null
  sku:                   string | null
  landing_page_enabled:  boolean | null
  landing_page_slug:     string | null
}

@Injectable()
export class SocialCommerceService {
  private readonly logger = new Logger(SocialCommerceService.name)

  constructor(private readonly meta: MetaCatalogService) {}

  // ─────────────────────────────────────────────────────────────────
  // STATUS / SETUP
  // ─────────────────────────────────────────────────────────────────

  async getStatus(orgId: string, channel: SocialCommerceChannel): Promise<SocialCommerceChannelRow | null> {
    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('*')
      .eq('organization_id', orgId)
      .eq('channel', channel)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data as SocialCommerceChannelRow) ?? null
  }

  async listAvailablePages(orgId: string): Promise<Array<{ id: string; name: string; instagram_business_account?: { id: string } }>> {
    const ch = await this.getStatus(orgId, 'instagram_shop')
    if (!ch?.access_token) throw new BadRequestException('Conecte o Meta primeiro')
    return this.meta.listPages(ch.access_token)
  }

  async listAvailableCatalogs(orgId: string, businessId?: string): Promise<Array<{ id: string; name: string }>> {
    const ch = await this.getStatus(orgId, 'instagram_shop')
    if (!ch?.access_token) throw new BadRequestException('Conecte o Meta primeiro')
    return this.meta.listCatalogs(ch.access_token, businessId)
  }

  /** Salva escolhas finais (Page + IG Business Account + Catalog ID).
   *  Marca o canal como 'connected'. */
  async setupCatalog(orgId: string, body: {
    page_id:               string
    instagram_account_id?: string
    catalog_id:            string
    pixel_id?:             string
  }): Promise<SocialCommerceChannelRow> {
    if (!body.page_id || !body.catalog_id) {
      throw new BadRequestException('page_id e catalog_id obrigatórios')
    }
    const ch = await this.getStatus(orgId, 'instagram_shop')
    if (!ch) throw new BadRequestException('Conecte o Meta primeiro (POST /social-commerce/instagram/connect)')

    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .update({
        external_account_id: body.instagram_account_id ?? body.page_id,
        external_catalog_id: body.catalog_id,
        external_pixel_id:   body.pixel_id ?? null,
        config: {
          ...ch.config,
          page_id:              body.page_id,
          instagram_account_id: body.instagram_account_id ?? null,
          catalog_id:           body.catalog_id,
          currency:             'BRL',
          auto_sync:            true,
        },
        status: 'connected',
        last_error: null,
      })
      .eq('id', ch.id)
      .select('*')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'falha no update'}`)
    return data as SocialCommerceChannelRow
  }

  async disconnect(orgId: string, channel: SocialCommerceChannel): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('social_commerce_channels')
      .update({
        access_token:     null,
        refresh_token:    null,
        token_expires_at: null,
        status:           'disconnected',
        last_error:       null,
      })
      .eq('organization_id', orgId)
      .eq('channel', channel)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  // ─────────────────────────────────────────────────────────────────
  // SYNC
  // ─────────────────────────────────────────────────────────────────

  /** Sincroniza 1 produto pra Meta. Cria mapping em
   *  social_commerce_products se ainda não existir. */
  async syncProduct(orgId: string, productId: string): Promise<{
    ok:                   true
    external_product_id?: string
    sync_status:          ProductSyncStatus
  }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    const product = await this.fetchProduct(productId, orgId)

    const metaData = this.mapToMetaFormat(product, ch)
    const retailerId = product.sku || product.id

    // Marca como syncing
    await this.upsertProductMapping(ch, productId, orgId, { sync_status: 'syncing' })

    try {
      const result = await this.meta.batchUpdateProducts(
        ch.access_token!,
        ch.external_catalog_id!,
        [{ method: 'UPDATE', retailer_id: retailerId, data: metaData }],
      )

      if (result.errors && result.errors.length > 0) {
        const msg = result.errors.map(e => e.message).join('; ').slice(0, 300)
        await this.upsertProductMapping(ch, productId, orgId, {
          sync_status: 'error',
          last_error:  msg,
        })
        await this.bumpChannelMetric(ch.id, { sync_errors: ch.sync_errors + 1 })
        throw new BadRequestException(`Meta rejeitou: ${msg}`)
      }

      const externalId = result.handles?.[0] ?? `${retailerId}`
      await this.upsertProductMapping(ch, productId, orgId, {
        sync_status:        'synced',
        external_product_id: externalId,
        last_synced_at:     new Date().toISOString(),
        synced_data:        metaData as unknown as Record<string, unknown>,
        last_error:         null,
      })
      await this.bumpChannelMetric(ch.id, { products_synced: ch.products_synced + 1, last_sync_at: new Date().toISOString(), last_sync_status: 'success' })
      return { ok: true, external_product_id: externalId, sync_status: 'synced' }
    } catch (e) {
      const msg = (e as Error).message ?? 'erro'
      await this.upsertProductMapping(ch, productId, orgId, {
        sync_status: 'error',
        last_error:  msg.slice(0, 300),
      })
      throw e
    }
  }

  /** Sync em massa — produtos com catalog_status='ready' que ainda não
   *  estão sincronizados, OU produtos cujo synced_data ficou stale (mudou
   *  preço/estoque/foto). Limita 100 por chamada pra não estourar API. */
  async syncAll(orgId: string): Promise<{
    synced: number
    failed: number
    skipped: number
  }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')

    // Produtos elegíveis: catalog_status='ready' OR sync_status='pending'/error
    const { data: candidates, error } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('organization_id', orgId)
      .in('catalog_status', ['ready', 'live'])
      .limit(100)
    if (error) throw new BadRequestException(`Erro ao listar produtos: ${error.message}`)
    if (!candidates?.length) return { synced: 0, failed: 0, skipped: 0 }

    let synced = 0, failed = 0, skipped = 0
    for (const c of candidates) {
      try {
        await this.syncProduct(orgId, c.id)
        synced++
      } catch (e) {
        const msg = (e as Error).message
        if (msg.includes('already')) skipped++
        else failed++
        this.logger.warn(`[social-commerce.syncAll] produto ${c.id} falhou: ${msg}`)
      }
    }

    return { synced, failed, skipped }
  }

  /** Worker — produtos com sync_status pending/error de canais conectados.
   *  Cross-org, retorna até `limit`. */
  async listPendingSyncs(limit = 20): Promise<Array<{
    organization_id: string
    product_id:      string
    channel:         SocialCommerceChannel
  }>> {
    const { data, error } = await supabaseAdmin
      .from('social_commerce_products')
      .select(`
        organization_id, product_id,
        channel:social_commerce_channels!inner(channel, status)
      `)
      .in('sync_status', ['pending', 'error'])
      .limit(limit)
    if (error) {
      this.logger.warn(`[social-commerce] listPendingSyncs: ${error.message}`)
      return []
    }
    type Row = {
      organization_id: string
      product_id:      string
      channel: { channel: SocialCommerceChannel; status: string } | { channel: SocialCommerceChannel; status: string }[]
    }
    return ((data ?? []) as Row[])
      .map(r => {
        const ch = Array.isArray(r.channel) ? r.channel[0] : r.channel
        return ch?.status === 'connected'
          ? { organization_id: r.organization_id, product_id: r.product_id, channel: ch.channel }
          : null
      })
      .filter((x): x is { organization_id: string; product_id: string; channel: SocialCommerceChannel } => x !== null)
  }

  /** Onda 3 / S3 — TikTok Shop readiness checklist. Não exige integração
   *  real ainda; só verifica se o produto está pronto pra ir quando a API
   *  liberar no Brasil. */
  async tiktokReadiness(orgId: string, productId: string): Promise<{
    ready: boolean
    checks: Array<{ key: string; ok: boolean; label: string; hint?: string }>
  }> {
    const { data: p, error } = await supabaseAdmin
      .from('products')
      .select('id, name, photo_urls, price, category, channel_titles')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!p)    throw new NotFoundException('Produto não encontrado')

    // Conta vídeos do creative aprovados ligados ao produto (best-effort)
    const { count: videoCount } = await supabaseAdmin
      .from('creative_videos')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', productId)
      .eq('status', 'approved')

    const photos: string[] = (p as { photo_urls: string[] | null }).photo_urls ?? []
    const ttTitle = ((p as { channel_titles: Record<string, string> | null }).channel_titles?.tiktok)
      ?? (p as { name: string }).name
    const checks = [
      { key: 'has_video',     label: 'Tem vídeo aprovado',           ok: (videoCount ?? 0) > 0,
        hint: 'Gere via IA Criativo (E3a) — TikTok Shop requer vídeo curto' },
      { key: 'short_title',   label: 'Título ≤ 60 chars',            ok: ttTitle.length <= 60,
        hint: `Título atual: ${ttTitle.length} chars. Defina channel_titles.tiktok mais curto.` },
      { key: 'has_price',     label: 'Tem preço',                    ok: ((p as { price: number | null }).price ?? 0) > 0 },
      { key: 'enough_photos', label: '≥ 5 imagens',                  ok: photos.length >= 5,
        hint: `Atual: ${photos.length}. TikTok Shop exige boa cobertura visual.` },
      { key: 'has_category',  label: 'Categoria definida',           ok: Boolean((p as { category: string | null }).category) },
    ]
    return { ready: checks.every(c => c.ok), checks }
  }

  async listSyncedProducts(orgId: string, channel: SocialCommerceChannel): Promise<SocialCommerceProductRow[]> {
    const ch = await this.getStatus(orgId, channel)
    if (!ch) return []
    const { data, error } = await supabaseAdmin
      .from('social_commerce_products')
      .select('*')
      .eq('channel_id', ch.id)
      .order('updated_at', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []) as SocialCommerceProductRow[]
  }

  /** Adiciona produtos ao escopo de sync (cria rows pending). */
  async addProductsToSync(orgId: string, channel: SocialCommerceChannel, productIds: string[]): Promise<{ added: number }> {
    const ch = await this.requireConnected(orgId, channel)
    const rows = productIds.map(pid => ({
      channel_id:      ch.id,
      product_id:      pid,
      organization_id: orgId,
      sync_status:     'pending' as ProductSyncStatus,
    }))
    const { error } = await supabaseAdmin
      .from('social_commerce_products')
      .upsert(rows, { onConflict: 'channel_id,product_id' })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { added: productIds.length }
  }

  async removeProductsFromSync(orgId: string, channel: SocialCommerceChannel, productIds: string[]): Promise<{ removed: number }> {
    const ch = await this.getStatus(orgId, channel)
    if (!ch) return { removed: 0 }

    // Manda DELETE pro Meta também
    if (ch.access_token && ch.external_catalog_id) {
      const products = await supabaseAdmin
        .from('social_commerce_products')
        .select('product_id, external_product_id')
        .eq('channel_id', ch.id)
        .in('product_id', productIds)
      const items = (products.data ?? [])
        .filter(p => p.external_product_id)
        .map(p => ({
          method:      'DELETE' as const,
          retailer_id: p.product_id,
        }))
      if (items.length > 0) {
        try {
          await this.meta.batchUpdateProducts(ch.access_token, ch.external_catalog_id, items)
        } catch (e) {
          this.logger.warn(`[social-commerce.removeProducts] Meta delete falhou: ${(e as Error).message}`)
        }
      }
    }

    const { error } = await supabaseAdmin
      .from('social_commerce_products')
      .delete()
      .eq('channel_id', ch.id)
      .in('product_id', productIds)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { removed: productIds.length }
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────

  private async requireConnected(orgId: string, channel: SocialCommerceChannel): Promise<SocialCommerceChannelRow> {
    const ch = await this.getStatus(orgId, channel)
    if (!ch) throw new NotFoundException('Canal não conectado')
    if (ch.status !== 'connected') {
      throw new BadRequestException(`Canal está ${ch.status}. Refaça setup pra continuar.`)
    }
    if (!ch.access_token || !ch.external_catalog_id) {
      throw new BadRequestException('Canal sem token ou catálogo configurado')
    }
    return ch
  }

  private async fetchProduct(productId: string, orgId: string): Promise<ProductForSync> {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        id, organization_id, name, brand, category, price, stock,
        description, ai_short_description, photo_urls,
        channel_titles, channel_descriptions, gtin, condition,
        ml_permalink, sku, landing_page_enabled, landing_page_slug
      `)
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error)  throw new BadRequestException(`Erro: ${error.message}`)
    if (!data)  throw new NotFoundException('Produto não encontrado')
    return data as ProductForSync
  }

  private async upsertProductMapping(
    ch: SocialCommerceChannelRow,
    productId: string,
    orgId: string,
    patch: Partial<SocialCommerceProductRow>,
  ): Promise<void> {
    await supabaseAdmin
      .from('social_commerce_products')
      .upsert(
        {
          channel_id:      ch.id,
          product_id:      productId,
          organization_id: orgId,
          ...patch,
        },
        { onConflict: 'channel_id,product_id' },
      )
  }

  private async bumpChannelMetric(channelId: string, patch: Partial<SocialCommerceChannelRow>): Promise<void> {
    await supabaseAdmin
      .from('social_commerce_channels')
      .update(patch)
      .eq('id', channelId)
  }

  /** Onda 3 / S2 — mapeia produto do catálogo pra formato Meta. */
  private mapToMetaFormat(p: ProductForSync, ch: SocialCommerceChannelRow): MetaProductData {
    const title = p.channel_titles?.instagram
      ?? p.channel_titles?.loja_propria
      ?? p.name

    const description = p.channel_descriptions?.instagram
      ?? p.ai_short_description
      ?? p.description
      ?? p.name

    const imageUrl = (p.photo_urls && p.photo_urls.length > 0) ? p.photo_urls[0] : ''
    if (!imageUrl) {
      throw new BadRequestException(`Produto ${p.id} sem photo_url — Meta exige imagem`)
    }

    const productUrl = p.landing_page_enabled && p.landing_page_slug
      ? `${process.env.FRONTEND_URL ?? 'https://eclick.app.br'}/loja/${p.organization_id}/${p.landing_page_slug}`
      : (p.ml_permalink ?? `${process.env.FRONTEND_URL ?? 'https://eclick.app.br'}/p/${p.id}`)

    const condition: MetaProductData['condition'] =
      p.condition === 'used'        ? 'used'
      : p.condition === 'refurbished' ? 'refurbished'
      : 'new'

    const stockNum = p.stock ?? 0
    const priceNum = p.price ?? 0

    if (priceNum <= 0) {
      throw new BadRequestException(`Produto ${p.id} sem preço — Meta exige price > 0`)
    }

    const out: MetaProductData = {
      title:        title.substring(0, 150),
      description:  description.substring(0, 9999),
      availability: stockNum > 0 ? 'in stock' : 'out of stock',
      condition,
      price:        `${priceNum.toFixed(2)} BRL`,
      link:         productUrl,
      image_link:   imageUrl,
      brand:        p.brand ?? 'Sem marca',
    }
    if (p.photo_urls && p.photo_urls.length > 1) {
      out.additional_image_link = p.photo_urls.slice(1, 10)
    }
    if (p.gtin)     out.gtin = p.gtin
    if (p.category) out.custom_label_0 = p.category
    return out
  }
}
