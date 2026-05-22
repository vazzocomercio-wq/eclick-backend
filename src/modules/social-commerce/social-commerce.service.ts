import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { MetaCatalogService } from './meta-catalog.service'
import type {
  SocialCommerceChannel,
  SocialCommerceChannelRow,
  SocialCommerceProductRow,
  ProductSyncStatus,
  MetaProductData,
} from './social-commerce.types'

/** Força https:// em URLs de imagem. Meta rejeita/não-carrega image_link
 *  em http (insecure). Fotos do ML vêm de http://http2.mlstatic.com mas o
 *  mesmo host serve em https — só trocar o protocolo. URLs já https ou
 *  protocol-relative (//) passam intactas; vazias retornam ''. */
function toHttps(url: string | null | undefined): string {
  if (!url) return ''
  const trimmed = url.trim()
  if (trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('http://'))  return 'https://' + trimmed.slice('http://'.length)
  if (trimmed.startsWith('//'))       return 'https:' + trimmed
  return trimmed
}

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
  storefront_visible:    boolean | null
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

  // ── Instagram Shopping — Tag de produtos (Frente 2) ──────────────────

  /** Resolve o IG Business Account a partir da Page configurada e persiste
   *  em config.instagram_account_id (corrige o null herdado do setup que
   *  só capturava a Page). Retorna a conta IG resolvida. */
  async resolveInstagramAccount(orgId: string): Promise<{
    id: string; username?: string; name?: string; profile_picture_url?: string
  }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    const pageId = (ch.config as Record<string, unknown>)?.page_id as string | undefined
      ?? ch.external_account_id
    if (!pageId) throw new BadRequestException('Page do Facebook não configurada no canal')

    const igAccount = await this.meta.getInstagramAccount(ch.access_token!, pageId)
    if (!igAccount) {
      throw new BadRequestException(
        'A Página do Facebook não tem uma conta Instagram Business vinculada. ' +
        'Vincule @vazzooficial à Página Vazzo no Meta Business Suite.',
      )
    }

    await supabaseAdmin
      .from('social_commerce_channels')
      .update({ config: { ...(ch.config as Record<string, unknown>), instagram_account_id: igAccount.id, instagram_username: igAccount.username } })
      .eq('id', ch.id)

    return igAccount
  }

  /** IG account id atual (do config) ou resolve on-the-fly. */
  private async getIgUserId(ch: SocialCommerceChannelRow): Promise<string> {
    const cfg = (ch.config ?? {}) as Record<string, unknown>
    const cached = cfg.instagram_account_id as string | null | undefined
    if (cached) return cached
    const pageId = (cfg.page_id as string | undefined) ?? ch.external_account_id
    if (!pageId) throw new BadRequestException('Page do Facebook não configurada')
    const ig = await this.meta.getInstagramAccount(ch.access_token!, pageId)
    if (!ig) throw new BadRequestException('Página sem conta Instagram Business vinculada')
    await supabaseAdmin
      .from('social_commerce_channels')
      .update({ config: { ...cfg, instagram_account_id: ig.id, instagram_username: ig.username } })
      .eq('id', ch.id)
    return ig.id
  }

  /** Lista posts/reels do IG, marcando quais já têm produtos tagueados
   *  (1 chamada extra de product_tags por mídia — só pros que são IMAGE/
   *  CAROUSEL, que aceitam tag). */
  async listInstagramMedia(orgId: string, after?: string): Promise<{
    data: Array<{
      id: string; media_type: string; media_url?: string; thumbnail_url?: string
      caption?: string; permalink?: string; timestamp?: string; tagged_count: number
    }>
    after?: string
  }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    const igUserId = await this.getIgUserId(ch)
    const media = await this.meta.listInstagramMedia(ch.access_token!, igUserId, 25, after)

    // Anota tagged_count por mídia (best-effort — falha não quebra a lista)
    const withTags = await Promise.all(media.data.map(async m => {
      let tagged_count = 0
      try {
        const tags = await this.meta.getMediaProductTags(ch.access_token!, m.id)
        tagged_count = tags.length
      } catch { /* mídia que não aceita tag ou sem permissão — ignora */ }
      return { ...m, tagged_count }
    }))
    return { data: withTags, after: media.after }
  }

  /** Produtos disponíveis pra taguear — vem do NOSSO DB (mappings já
   *  sincronizados ao catálogo Meta). external_product_id é o ID do produto
   *  no catálogo IG, que é o que tagProductsOnMedia espera. */
  async listTaggableProducts(orgId: string, search?: string): Promise<Array<{
    product_id: string; external_product_id: string; name: string; image?: string; price?: number
  }>> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    const { data, error } = await supabaseAdmin
      .from('social_commerce_products')
      .select('product_id, external_product_id, synced_data')
      .eq('channel_id', ch.id)
      .eq('sync_status', 'synced')
      .not('external_product_id', 'is', null)
      .limit(500)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    let rows = (data ?? []).map(r => {
      const sd = (r.synced_data ?? {}) as Record<string, unknown>
      return {
        product_id:          r.product_id as string,
        external_product_id: r.external_product_id as string,
        name:                (sd.title as string) ?? '',
        image:               (sd.image_link as string) ?? undefined,
        price:               undefined as number | undefined,
      }
    })
    if (search?.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(r => r.name.toLowerCase().includes(q))
    }
    return rows
  }

  /** Lê tags existentes de uma mídia. */
  async getMediaTags(orgId: string, mediaId: string) {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    return this.meta.getMediaProductTags(ch.access_token!, mediaId)
  }

  /** Tagueia produtos numa mídia. `tags[].external_product_id` é o ID do
   *  produto no catálogo IG (não o product_id interno). x,y opcionais (0-1). */
  async tagProductsOnMedia(orgId: string, mediaId: string, tags: Array<{
    external_product_id: string; x?: number; y?: number
  }>): Promise<{ success: boolean; tagged: number }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    if (!tags.length) throw new BadRequestException('Nenhum produto pra taguear')
    await this.meta.tagProductsOnMedia(
      ch.access_token!,
      mediaId,
      tags.map(t => ({ product_id: t.external_product_id, x: t.x, y: t.y })),
    )
    // Valida na fonte (regra de ouro Meta) — confirma que landou
    const after = await this.meta.getMediaProductTags(ch.access_token!, mediaId)
    return { success: true, tagged: after.length }
  }

  /** Remove tags de produtos de uma mídia. */
  async untagProductsOnMedia(orgId: string, mediaId: string, externalProductIds: string[]): Promise<{ success: boolean }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    return this.meta.untagProductsOnMedia(ch.access_token!, mediaId, externalProductIds)
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

  // ── WhatsApp Business — vincular catalog ao WABA ────────────────────

  /** Lista WhatsApp Business Accounts (WABAs) do user.
   *  Reusa o access_token do channel 'instagram_shop' — o OAuth Meta
   *  cobre todos os scopes (catalog + whatsapp + business). */
  async listAvailableWabas(orgId: string): Promise<Array<{
    id: string; name: string; business_id: string | null
    phone_numbers?: Array<{ id: string; display_phone_number: string; verified_name: string }>
  }>> {
    const ch = await this.getStatus(orgId, 'instagram_shop')
    if (!ch?.access_token) throw new BadRequestException('Conecte o Meta primeiro')
    return this.meta.listWabas(ch.access_token)
  }

  /** Configura o canal whatsapp_business: vincula o catalog ao WABA no
   *  Meta + persiste linha em social_commerce_channels. Reusa o token
   *  Meta da row instagram_shop. */
  async setupWhatsAppCatalog(orgId: string, body: {
    waba_id:           string
    catalog_id:        string
    phone_number_id?:  string  // pra envio futuro via Cloud API
    display_phone?:    string  // pra widget "Ver catalogo" da loja
  }): Promise<SocialCommerceChannelRow> {
    if (!body.waba_id || !body.catalog_id) {
      throw new BadRequestException('waba_id e catalog_id obrigatórios')
    }
    const ig = await this.getStatus(orgId, 'instagram_shop')
    if (!ig?.access_token) {
      throw new BadRequestException('Conecte o Meta primeiro (POST /social-commerce/instagram/connect)')
    }

    // 1) Vincula no Meta (POST /{waba_id}/product_catalogs?catalog_id=)
    await this.meta.linkCatalogToWaba(ig.access_token, body.waba_id, body.catalog_id)

    // 2) Upsert row whatsapp_business
    const existing = await this.getStatus(orgId, 'whatsapp_business')
    const configPatch = {
      waba_id:          body.waba_id,
      catalog_id:       body.catalog_id,
      phone_number_id:  body.phone_number_id ?? null,
      display_phone:    body.display_phone ?? null,
    }

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('social_commerce_channels')
        .update({
          access_token:        ig.access_token,
          token_expires_at:    ig.token_expires_at,
          external_account_id: body.waba_id,
          external_catalog_id: body.catalog_id,
          config: { ...existing.config, ...configPatch },
          status: 'connected',
          last_error: null,
        })
        .eq('id', existing.id)
        .select('*').maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
      return data as SocialCommerceChannelRow
    }

    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .insert({
        organization_id:     orgId,
        channel:             'whatsapp_business',
        access_token:        ig.access_token,
        token_expires_at:    ig.token_expires_at,
        external_account_id: body.waba_id,
        external_catalog_id: body.catalog_id,
        config:              configPatch,
        status:              'connected',
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as SocialCommerceChannelRow
  }

  /** Bypass — quando o BM eh SMB business type, a Meta recusa linkCatalogToWaba
   *  com erro #10 mesmo se a UI tambem nao oferecer caminho manual. Esse
   *  metodo PULA a chamada Meta e salva o channel local como connected
   *  pra a UI da loja exibir o widget "Ver catalogo". A vinculacao Meta
   *  real fica pendente ate Business Verification aprovar — apos isso,
   *  rodar `setupWhatsAppCatalog` normal pra fazer o link via API. */
  async setupWhatsAppCatalogManual(orgId: string, body: {
    waba_id:           string
    catalog_id:        string
    phone_number_id?:  string
    display_phone?:    string
  }): Promise<SocialCommerceChannelRow> {
    if (!body.waba_id || !body.catalog_id) {
      throw new BadRequestException('waba_id e catalog_id obrigatórios')
    }
    const ig = await this.getStatus(orgId, 'instagram_shop')
    if (!ig?.access_token) {
      throw new BadRequestException('Conecte o Meta primeiro')
    }

    const existing = await this.getStatus(orgId, 'whatsapp_business')
    const configPatch = {
      waba_id:          body.waba_id,
      catalog_id:       body.catalog_id,
      phone_number_id:  body.phone_number_id ?? null,
      display_phone:    body.display_phone ?? null,
      manual_link:      true,  // marca como vinculado manualmente (sem chamada API Meta)
    }

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('social_commerce_channels')
        .update({
          access_token:        ig.access_token,
          token_expires_at:    ig.token_expires_at,
          external_account_id: body.waba_id,
          external_catalog_id: body.catalog_id,
          config: { ...existing.config, ...configPatch },
          status: 'connected',
          last_error: null,
        })
        .eq('id', existing.id)
        .select('*').maybeSingle()
      if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
      return data as SocialCommerceChannelRow
    }

    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .insert({
        organization_id:     orgId,
        channel:             'whatsapp_business',
        access_token:        ig.access_token,
        token_expires_at:    ig.token_expires_at,
        external_account_id: body.waba_id,
        external_catalog_id: body.catalog_id,
        config:              configPatch,
        status:              'connected',
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'sem dados'}`)
    return data as SocialCommerceChannelRow
  }

  /** Desvincula no Meta + zera status local. */
  async disconnectWhatsAppCatalog(orgId: string): Promise<{ ok: true }> {
    const ch = await this.getStatus(orgId, 'whatsapp_business')
    if (ch?.access_token && ch.external_account_id && ch.external_catalog_id) {
      try {
        await this.meta.unlinkCatalogFromWaba(ch.access_token, ch.external_account_id, ch.external_catalog_id)
      } catch { /* best-effort — segue desconectando local */ }
    }
    return this.disconnect(orgId, 'whatsapp_business')
  }

  /** Auto-sync usado pelo ProductsService quando produto vira
   *  storefront_visible=true. Best-effort: se a org nao tem canal Meta
   *  conectado, retorna { skipped:true } sem lancar. Se tem, dispara
   *  syncProduct em paralelo (settled — falha de um nao bloqueia os
   *  outros). Idempotente. */
  async tryAutoSyncProducts(
    orgId: string,
    productIds: string[],
  ): Promise<{ skipped: boolean; synced: number; failed: number }> {
    if (!productIds || productIds.length === 0) {
      return { skipped: true, synced: 0, failed: 0 }
    }
    const ch = await this.getStatus(orgId, 'instagram_shop')
    if (!ch || ch.status !== 'connected') {
      // Sem canal Meta conectado — silencioso. Lojista podera rodar sync
      // depois quando conectar.
      return { skipped: true, synced: 0, failed: 0 }
    }
    const results = await Promise.allSettled(
      productIds.map(pid => this.syncProduct(orgId, pid)),
    )
    const synced = results.filter(r => r.status === 'fulfilled').length
    const failed = results.length - synced
    return { skipped: false, synced, failed }
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
    const storeSlug = await this.fetchStoreSlug(orgId)

    const metaData = this.mapToMetaFormat(product, ch, storeSlug)
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

  /** Sync em massa — todo produto visível na vitrine (`storefront_visible=true`)
   *  com nome + preço vai pro catálogo Meta.
   *
   *  Implementação: UMA chamada batch por chunk de 1000 produtos
   *  (Meta `items_batch` aceita até 5000 items). Antes era 1 chamada por
   *  produto — bate rate limit #80014 com 100+ produtos rapidinho. */
  async syncAll(orgId: string): Promise<{
    synced: number
    failed: number
    skipped: number
  }> {
    const ch = await this.requireConnected(orgId, 'instagram_shop')
    const storeSlug = await this.fetchStoreSlug(orgId)

    // 1) Lista produtos visíveis com tudo que mapToMetaFormat precisa
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select(`
        id, organization_id, name, brand, category, price, stock,
        description, ai_short_description, photo_urls,
        channel_titles, channel_descriptions, gtin, condition,
        ml_permalink, sku, storefront_visible
      `)
      .eq('organization_id', orgId)
      .eq('storefront_visible', true)
      .limit(5000)
    if (error) throw new BadRequestException(`Erro ao listar: ${error.message}`)
    if (!products?.length) return { synced: 0, failed: 0, skipped: 0 }

    // 2) Constrói requests + pula inválidos
    type R = { method: 'UPDATE'; retailer_id: string; data: MetaProductData; product_id: string }
    const requests: R[] = []
    let skipped = 0
    for (const p of products as ProductForSync[]) {
      if (!p.name?.trim() || !p.price || Number(p.price) <= 0) {
        skipped++
        continue
      }
      const metaData = this.mapToMetaFormat(p, ch, storeSlug)
      const retailerId = p.sku || p.id
      requests.push({ method: 'UPDATE', retailer_id: retailerId, data: metaData, product_id: p.id })
    }
    if (!requests.length) return { synced: 0, failed: 0, skipped }

    // 3) Envia em chunks de 1000 (margem do limite 5000 da Meta)
    const CHUNK_SIZE = 1000
    let synced = 0, failed = 0
    const now = new Date().toISOString()

    for (let i = 0; i < requests.length; i += CHUNK_SIZE) {
      const chunk = requests.slice(i, i + CHUNK_SIZE)
      try {
        const result = await this.meta.batchUpdateProducts(
          ch.access_token!,
          ch.external_catalog_id!,
          chunk.map(r => ({ method: r.method, retailer_id: r.retailer_id, data: r.data })),
        )

        // Erros em batch (rate limit, auth, etc) — marca todo o chunk como error
        if (result.errors && result.errors.length > 0) {
          const errMsg = result.errors.map(e => e.message).join('; ').slice(0, 300)
          const errorRows = chunk.map(r => ({
            channel_id:      ch.id,
            product_id:      r.product_id,
            organization_id: orgId,
            sync_status:     'error' as const,
            last_error:      errMsg,
          }))
          await supabaseAdmin
            .from('social_commerce_products')
            .upsert(errorRows, { onConflict: 'channel_id,product_id' })
          failed += chunk.length
          this.logger.warn(`[social-commerce.syncAll] chunk ${i / CHUNK_SIZE} (${chunk.length} items) falhou: ${errMsg}`)
          continue
        }

        // Sucesso — marca todos como synced num upsert só
        const successRows = chunk.map((r, idx) => ({
          channel_id:          ch.id,
          product_id:          r.product_id,
          organization_id:     orgId,
          sync_status:         'synced' as const,
          external_product_id: result.handles?.[idx] ?? r.retailer_id,
          last_synced_at:      now,
          synced_data:         r.data as unknown as Record<string, unknown>,
          last_error:          null,
        }))
        await supabaseAdmin
          .from('social_commerce_products')
          .upsert(successRows, { onConflict: 'channel_id,product_id' })
        synced += chunk.length
      } catch (e) {
        const msg = (e as Error).message ?? 'erro'
        this.logger.warn(`[social-commerce.syncAll] chunk ${i / CHUNK_SIZE} excecao: ${msg}`)
        failed += chunk.length
      }
    }

    // 4) Atualiza contadores. O catalog Meta eh compartilhado entre
    //    instagram_shop e whatsapp_business (mesmo external_catalog_id),
    //    entao TODOS os canais do org que apontam pro mesmo catalog devem
    //    refletir o sync — senao a tela do WhatsApp mostra "0 sincronizados"
    //    mesmo depois do sync rodar (porque o counter so subiu na row do IG).
    //
    //    products_synced/sync_errors sao SETADOS (nao somados): syncAll
    //    re-sincroniza TODOS os produtos visiveis a cada chamada, entao o
    //    total deste run JA E o total atual. Somar inflava o numero a cada
    //    clique + cron (chegou em 2714 com ~260 produtos reais).
    const status = failed === 0 ? 'success' : (synced > 0 ? 'partial' : 'error')
    await supabaseAdmin
      .from('social_commerce_channels')
      .update({
        products_synced:  synced,
        sync_errors:      failed,
        last_sync_at:     now,
        last_sync_status: status,
      })
      .eq('organization_id', orgId)
      .eq('external_catalog_id', ch.external_catalog_id!)

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
    // landing_page_enabled / landing_page_slug nao existem mais em products
    // (eram da fase antiga de "landing page por produto"). storefront_visible
    // substitui o conceito. URL publica do produto eh montada via
    // store_config.store_slug (lookup separado em fetchStoreSlug).
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        id, organization_id, name, brand, category, price, stock,
        description, ai_short_description, photo_urls,
        channel_titles, channel_descriptions, gtin, condition,
        ml_permalink, sku, storefront_visible
      `)
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error)  throw new BadRequestException(`Erro: ${error.message}`)
    if (!data)  throw new NotFoundException('Produto não encontrado')
    return data as ProductForSync
  }

  /** Cache de store_slug por org_id pra evitar N queries durante syncAll. */
  private storeSlugCache = new Map<string, string | null>()
  private async fetchStoreSlug(orgId: string): Promise<string | null> {
    if (this.storeSlugCache.has(orgId)) return this.storeSlugCache.get(orgId) ?? null
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('store_slug')
      .eq('organization_id', orgId)
      .maybeSingle()
    const slug = (data?.store_slug as string | null) ?? null
    this.storeSlugCache.set(orgId, slug)
    return slug
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

  /** Onda 3 / S2 — mapeia produto do catálogo pra formato Meta.
   *  `storeSlug` vem do store_config da org — usado pra montar a URL
   *  publica do produto na vitrine (`/loja/{slug}/produto/{id}`). Quando
   *  ausente, cai pro ml_permalink ou pra URL admin de fallback. */
  private mapToMetaFormat(
    p: ProductForSync,
    ch: SocialCommerceChannelRow,
    storeSlug: string | null,
  ): MetaProductData {
    const title = p.channel_titles?.instagram
      ?? p.channel_titles?.loja_propria
      ?? p.name

    const description = p.channel_descriptions?.instagram
      ?? p.ai_short_description
      ?? p.description
      ?? p.name

    const imageUrl = (p.photo_urls && p.photo_urls.length > 0) ? toHttps(p.photo_urls[0]) : ''
    if (!imageUrl) {
      throw new BadRequestException(`Produto ${p.id} sem photo_url — Meta exige imagem`)
    }

    const frontendBase = process.env.FRONTEND_URL ?? 'https://eclick.app.br'
    const productUrl = storeSlug
      ? `${frontendBase}/loja/${storeSlug}/produto/${p.id}`
      : (p.ml_permalink ?? `${frontendBase}/p/${p.id}`)

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
    // item_type='PRODUCT_ITEM' vai no top-level do batch (em meta-catalog
    // batchUpdateProducts) — nao em cada item.data.
    if (p.photo_urls && p.photo_urls.length > 1) {
      out.additional_image_link = p.photo_urls.slice(1, 10).map(toHttps)
    }
    if (p.gtin)     out.gtin = p.gtin
    if (p.category) out.custom_label_0 = p.category
    return out
  }

  // ─────────────────────────────────────────────────────────────────
  // CRON — sync diario do catalogo Meta
  // ─────────────────────────────────────────────────────────────────

  /** Reconciliacao noturna: 05:00 BRT (08:00 UTC) varre todas as orgs
   *  com canal `instagram_shop` connected e roda `syncAll`.
   *
   *  Justificativa: auto-sync ao marcar produto visivel cobre o caso
   *  comum, mas pode falhar (Meta API com 5xx, throttle, token expirado
   *  no momento exato). Cron pega o que escapou + reflete mudancas de
   *  preco/stock/foto que o lojista faz fora do toggle de visibilidade.
   *
   *  Best-effort: erros por org sao logados e nao quebram o loop. */
  @Cron('0 5 * * *', { name: 'syncSocialCommerceCatalogs', timeZone: 'America/Sao_Paulo' })
  async dailyCatalogSync(): Promise<void> {
    const { data: channels, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('organization_id, id')
      .eq('channel', 'instagram_shop')
      .eq('status', 'connected')

    if (error) {
      this.logger.error(`[daily-sync] select channels falhou: ${error.message}`)
      return
    }
    if (!channels || channels.length === 0) {
      this.logger.log('[daily-sync] nenhum canal conectado — skip')
      return
    }

    this.logger.log(`[daily-sync] iniciando — ${channels.length} canais`)
    let totalSynced = 0, totalFailed = 0
    for (const ch of channels as Array<{ organization_id: string; id: string }>) {
      try {
        const r = await this.syncAll(ch.organization_id)
        totalSynced += r.synced
        totalFailed += r.failed
        this.logger.log(
          `[daily-sync] org=${ch.organization_id.slice(0,8)} synced=${r.synced} failed=${r.failed} skipped=${r.skipped}`,
        )
      } catch (e) {
        this.logger.warn(`[daily-sync] org=${ch.organization_id.slice(0,8)} falhou: ${(e as Error).message}`)
      }
    }
    this.logger.log(`[daily-sync] concluido — synced=${totalSynced} failed=${totalFailed}`)
  }
}
