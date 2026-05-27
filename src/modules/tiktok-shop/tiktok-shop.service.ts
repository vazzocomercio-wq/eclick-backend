import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { encryptConfig, decryptConfig } from '../marketplace/crypto.util'
import { signTikTokShop } from './tiktok-shop-sign.util'

/**
 * TikTok Shop (app Personalizado) — Fase 1: OAuth da loja.
 *
 * Fluxo: front pede /tiktok-shop/oauth/auth-url → redireciona o lojista pra
 * services.tiktokshop.com/open/authorize?service_id=...&state=... → TikTok
 * chama nosso callback com code+state → trocamos por access/refresh token e
 * salvamos CIFRADO em tiktok_shop_credentials.
 *
 * A troca de token NÃO é assinada (endpoint de auth). A assinatura HMAC das
 * APIs de negócio (pedidos/produtos) entra na Fase 2.
 *
 * Docs: https://partner.tiktokshop.com/docv2/page/...(authorization)
 */

const TTS_AUTHORIZE = 'https://services.tiktokshop.com/open/authorize'
const TTS_TOKEN = 'https://auth.tiktok-shops.com/api/v2/token/get'
const TTS_API_BASE = 'https://open-api.tiktokglobalshop.com'

interface TtsTokenData {
  access_token?: string
  access_token_expire_in?: number
  refresh_token?: string
  refresh_token_expire_in?: number
  open_id?: string
  seller_name?: string
  seller_base_region?: string
  granted_scopes?: string[]
}

interface TtsTokenResponse {
  code?: number
  message?: string
  data?: TtsTokenData
}

interface OAuthStateRow {
  organization_id: string
  redirect_to: string | null
}

interface TtsOrder {
  id: string
  status?: string
  buyer_message?: string
  recipient_address?: { name?: string }
  payment?: { total_amount?: string; currency?: string }
  line_items?: unknown[]
  create_time?: number
  update_time?: number
}

interface TtsSku {
  id: string
  seller_sku?: string
  price?: { currency?: string; sale_price?: string; tax_exclusive_price?: string }
  inventory?: Array<{ quantity?: number; warehouse_id?: string }>
  status_info?: { status?: string }
  sales_attributes?: Array<{ name?: string; value_name?: string }>
  sku_img?: { urls?: string[] }
}

interface TtsProduct {
  id: string
  title?: string
  status?: string
  skus?: TtsSku[]
  main_images?: Array<{ uri?: string; urls?: string[] }>
  // Campos extras que SÓ vêm no detalhe (GET /product/202309/products/{id}),
  // não no search. Opcionais porque o search devolve só o produto "leve".
  description?: string
  category_chains?: Array<{ id?: string; local_name?: string; is_leaf?: boolean }>
}

/** Linha de anúncio TikTok no nível do SKU (unidade vendável: cada SKU tem
 *  preço/estoque/seller_sku próprios). É o shape que a página de Anúncios
 *  TikTok consome — espelha o MListing do ML no que faz sentido. */
export interface TkListing {
  tts_product_id: string
  sku_id: string
  seller_sku: string | null
  title: string
  variation_name: string | null
  status: string | null // status do PRODUTO (ACTIVATE/PENDING/DRAFT/…)
  sku_status: string | null // status do SKU (NORMAL/…)
  price: number | null
  currency: string | null
  stock: number
  warehouse_id: string | null
  image: string | null
  category: string | null
  sku_count: number
  synced_at: string | null
}

/** Abas da página (mesmo vocabulário do ML). */
export type TkTab = 'active' | 'paused' | 'closed' | 'under_review'

interface TtsWebhookPayload {
  type?: number
  shop_id?: string | number
  timestamp?: number
  data?: Record<string, unknown>
}

@Injectable()
export class TikTokShopService {
  private readonly logger = new Logger(TikTokShopService.name)

  private env(): { appKey: string; appSecret: string; serviceId: string } {
    const appKey = process.env.TIKTOK_SHOP_APP_KEY
    const appSecret = process.env.TIKTOK_SHOP_APP_SECRET
    const serviceId = process.env.TIKTOK_SHOP_SERVICE_ID
    if (!appKey || !appSecret || !serviceId) {
      throw new HttpException(
        'TikTok Shop não está configurado no servidor (app_key/app_secret/service_id).',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
    return { appKey, appSecret, serviceId }
  }

  isConfigured(): boolean {
    return !!(
      process.env.TIKTOK_SHOP_APP_KEY &&
      process.env.TIKTOK_SHOP_APP_SECRET &&
      process.env.TIKTOK_SHOP_SERVICE_ID
    )
  }

  /** Gera state CSRF, persiste em oauth_state e devolve a URL de autorização. */
  async buildAuthorizeUrl(
    orgId: string,
    userId: string,
    redirectTo?: string,
  ): Promise<{ authorize_url: string }> {
    const { serviceId } = this.env()
    const state = crypto.randomBytes(48).toString('base64url')

    const { error } = await supabaseAdmin.from('oauth_state').insert({
      organization_id: orgId,
      user_id: userId,
      provider: 'tiktok_shop',
      state,
      redirect_to: redirectTo ?? null,
    })
    if (error) {
      this.logger.error(`[tts.oauth] persist state falhou: ${error.message}`)
      throw new HttpException(
        'Falha ao iniciar OAuth — tente novamente',
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }

    const params = new URLSearchParams({ service_id: serviceId, state })
    return { authorize_url: `${TTS_AUTHORIZE}?${params.toString()}` }
  }

  /** Callback: valida o state, troca o code por token e salva cifrado. */
  async exchangeCode(
    code: string,
    state: string,
  ): Promise<{ orgId: string; sellerName: string | null; redirect_to: string | null }> {
    const { appKey, appSecret } = this.env()

    const { data: stateRow, error } = await supabaseAdmin
      .from('oauth_state')
      .select('organization_id, redirect_to')
      .eq('state', state)
      .eq('provider', 'tiktok_shop')
      .maybeSingle<OAuthStateRow>()
    if (error || !stateRow) {
      throw new BadRequestException('state inválido ou expirado')
    }
    await supabaseAdmin.from('oauth_state').delete().eq('state', state)

    const params = new URLSearchParams({
      app_key: appKey,
      app_secret: appSecret,
      auth_code: code,
      grant_type: 'authorized_code',
    })
    const res = await fetch(`${TTS_TOKEN}?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json()) as TtsTokenResponse
    if (!res.ok || json.code !== 0 || !json.data?.access_token) {
      throw new BadRequestException(
        `TikTok Shop token exchange falhou: ${json.message ?? `HTTP ${res.status}`}`,
      )
    }

    await this.persist(stateRow.organization_id, json.data, json)
    return {
      orgId: stateRow.organization_id,
      sellerName: json.data.seller_name ?? null,
      redirect_to: stateRow.redirect_to ?? null,
    }
  }

  private async persist(
    orgId: string,
    d: TtsTokenData,
    raw: unknown,
  ): Promise<void> {
    const credentials_encrypted = encryptConfig({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
    })
    if (!credentials_encrypted) {
      throw new BadRequestException('Falha ao cifrar credenciais do TikTok Shop')
    }
    // TikTok Shop devolve *_expire_in como timestamp Unix ABSOLUTO (segundos).
    const accessExp = d.access_token_expire_in
      ? new Date(d.access_token_expire_in * 1000).toISOString()
      : null
    const refreshExp = d.refresh_token_expire_in
      ? new Date(d.refresh_token_expire_in * 1000).toISOString()
      : null

    // Detecta TROCA DE CONTA: se o open_id mudou (lojista reautorizou com outra
    // conta/loja), o shop_id/shop_cipher guardados são de OUTRA loja e ficariam
    // obsoletos (o upsert não toca colunas ausentes). Zeramos pra forçar o
    // getShopCipher a re-buscar a loja certa via getAuthorizedShops. Sem isso,
    // chamadas de pedido/produto usariam o cipher da loja anterior.
    const { data: existing } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('open_id')
      .eq('organization_id', orgId)
      .maybeSingle<{ open_id: string | null }>()
    const accountChanged =
      !!existing?.open_id && existing.open_id !== (d.open_id ?? null)

    const row: Record<string, unknown> = {
      organization_id: orgId,
      open_id: d.open_id ?? null,
      seller_name: d.seller_name ?? null,
      region: d.seller_base_region ?? null,
      credentials_encrypted,
      scopes: d.granted_scopes ?? [],
      access_expires_at: accessExp,
      refresh_expires_at: refreshExp,
      status: 'connected',
      raw: raw as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    }
    if (accountChanged) {
      row.shop_id = null
      row.shop_cipher = null
    }

    const { error } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .upsert(row, { onConflict: 'organization_id' })
    if (error) {
      throw new BadRequestException(
        `Falha ao salvar credencial TikTok Shop: ${error.message}`,
      )
    }
  }

  /** Status pra UI. */
  async getStatus(orgId: string): Promise<{
    configured_globally: boolean
    connected: boolean
    seller_name: string | null
    region: string | null
    access_expires_at: string | null
  }> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('seller_name, region, status, access_expires_at')
      .eq('organization_id', orgId)
      .maybeSingle<{
        seller_name: string | null
        region: string | null
        status: string
        access_expires_at: string | null
      }>()
    return {
      configured_globally: this.isConfigured(),
      connected: !!data && data.status === 'connected',
      seller_name: data?.seller_name ?? null,
      region: data?.region ?? null,
      access_expires_at: data?.access_expires_at ?? null,
    }
  }

  async disconnect(orgId: string): Promise<{ ok: true }> {
    await supabaseAdmin
      .from('tiktok_shop_credentials')
      .delete()
      .eq('organization_id', orgId)
    return { ok: true }
  }

  /** Access token decifrado — base pras Fases 2+ (chamadas de negócio). */
  async getAccessToken(orgId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('credentials_encrypted')
      .eq('organization_id', orgId)
      .maybeSingle<{ credentials_encrypted: string }>()
    if (!data?.credentials_encrypted) return null
    const dec = decryptConfig(data.credentials_encrypted)
    const token = dec?.access_token
    return typeof token === 'string' ? token : null
  }

  // ── Fase 2: chamadas de negócio (assinadas HMAC) ──────────────────────────

  /** Request assinada às APIs de negócio do TikTok Shop (open-api). */
  private async ttsRequest<T>(args: {
    method: 'GET' | 'POST'
    path: string
    accessToken: string
    query?: Record<string, string | number | undefined>
    body?: unknown
  }): Promise<T> {
    const { appKey, appSecret } = this.env()
    const baseQuery: Record<string, string | number | undefined> = {
      app_key: appKey,
      timestamp: Math.floor(Date.now() / 1000),
      ...(args.query ?? {}),
    }
    const bodyStr =
      args.body !== undefined ? JSON.stringify(args.body) : undefined
    const sign = signTikTokShop({
      appSecret,
      path: args.path,
      query: baseQuery,
      body: bodyStr,
    })
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(baseQuery)) {
      if (v !== undefined && v !== '') qs.set(k, String(v))
    }
    qs.set('sign', sign)

    const res = await fetch(`${TTS_API_BASE}${args.path}?${qs.toString()}`, {
      method: args.method,
      headers: {
        'x-tts-access-token': args.accessToken,
        'Content-Type': 'application/json',
      },
      body: bodyStr,
      signal: AbortSignal.timeout(25_000),
    })
    const json = (await res.json()) as {
      code?: number
      message?: string
      data?: T
    }
    if (!res.ok || json.code !== 0) {
      throw new BadRequestException(
        `TikTok Shop ${args.path} falhou: ${json.message ?? `HTTP ${res.status}`} (code ${json.code ?? '?'})`,
      )
    }
    return json.data as T
  }

  /** Lista as lojas autorizadas e guarda o shop_cipher (necessário pras
   *  chamadas de pedido/produto das próximas fases). */
  async getAuthorizedShops(orgId: string): Promise<
    Array<{ id: string; name: string; region: string; cipher: string; code?: string }>
  > {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')

    const data = await this.ttsRequest<{
      shops?: Array<{
        id: string
        name: string
        region: string
        seller_type?: string
        cipher: string
        code?: string
      }>
    }>({ method: 'GET', path: '/authorization/202309/shops', accessToken })

    const shops = data.shops ?? []
    const first = shops[0]
    if (first?.cipher) {
      await supabaseAdmin
        .from('tiktok_shop_credentials')
        .update({
          shop_id: first.id,
          shop_cipher: first.cipher,
          seller_name: first.name ?? undefined,
          region: first.region ?? undefined,
          updated_at: new Date().toISOString(),
        })
        .eq('organization_id', orgId)
    }
    return shops
  }

  // ── Fase 2b: pedidos ──────────────────────────────────────────────────────

  /** shop_cipher salvo; se faltar, busca via getAuthorizedShops. */
  private async getShopCipher(orgId: string): Promise<string> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('shop_cipher')
      .eq('organization_id', orgId)
      .maybeSingle<{ shop_cipher: string | null }>()
    if (data?.shop_cipher) return data.shop_cipher
    const shops = await this.getAuthorizedShops(orgId)
    const cipher = shops[0]?.cipher
    if (!cipher) {
      throw new BadRequestException('Nenhuma loja TikTok Shop autorizada encontrada')
    }
    return cipher
  }

  /** Importa pedidos do TikTok Shop → tiktok_shop_orders (isolada). Até maxPages. */
  async importOrders(
    orgId: string,
    maxPages = 4,
  ): Promise<{ imported: number; pages: number }> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)

    const { data: cred } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('shop_id')
      .eq('organization_id', orgId)
      .maybeSingle<{ shop_id: string | null }>()
    const shopId = cred?.shop_id ?? null

    let pageToken: string | undefined
    let imported = 0
    let pages = 0
    do {
      const data = await this.ttsRequest<{
        orders?: TtsOrder[]
        next_page_token?: string
      }>({
        method: 'POST',
        path: '/order/202309/orders/search',
        accessToken,
        query: { shop_cipher: shopCipher, page_size: 50, page_token: pageToken },
        body: {},
      })
      const orders = data.orders ?? []
      pages++

      for (const o of orders) {
        if (await this.persistOrder(orgId, shopId, o)) imported++
      }

      pageToken =
        data.next_page_token && orders.length > 0 ? data.next_page_token : undefined
    } while (pageToken && pages < maxPages)

    return { imported, pages }
  }

  /** Normaliza o status do TikTok pro vocabulário da tela central (igual ML). */
  private mapTtsStatus(s?: string): string {
    switch ((s ?? '').toUpperCase()) {
      case 'UNPAID':
      case 'ON_HOLD':
        return 'pending'
      case 'AWAITING_SHIPMENT':
      case 'AWAITING_COLLECTION':
      case 'PARTIALLY_SHIPPING':
        return 'paid'
      case 'IN_TRANSIT':
        return 'shipped'
      case 'DELIVERED':
      case 'COMPLETED':
        return 'delivered'
      case 'CANCELLED':
      case 'CANCEL':
        return 'cancelled'
      default:
        return 'pending'
    }
  }

  /** Upsert de UM pedido: tabela isolada + espelho no modelo unificado `orders`
   *  (tela central, com ML/manual). product_id=NULL → ZERO impacto no estoque
   *  (cron de estoque só lê platform='mercadolivre' + product_id not null).
   *  source/platform='tiktok_shop' isola do ML. Retorna true se a isolada salvou.
   *  Reutilizado por importOrders (batch) e pelo webhook (alvo, tempo real). */
  private async persistOrder(
    orgId: string,
    shopId: string | null,
    o: TtsOrder,
  ): Promise<boolean> {
    const { error } = await supabaseAdmin.from('tiktok_shop_orders').upsert(
      {
        organization_id: orgId,
        shop_id: shopId,
        tts_order_id: o.id,
        order_status: o.status ?? null,
        buyer_message: o.buyer_message ?? null,
        recipient_name: o.recipient_address?.name ?? null,
        total_amount: o.payment?.total_amount ?? null,
        currency: o.payment?.currency ?? null,
        line_item_count: o.line_items?.length ?? 0,
        tts_create_time: o.create_time ?? null,
        tts_update_time: o.update_time ?? null,
        raw: o as unknown as Record<string, unknown>,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,tts_order_id' },
    )

    const total = o.payment?.total_amount ? Number(o.payment.total_amount) : null
    const { error: ordErr } = await supabaseAdmin.from('orders').upsert(
      {
        organization_id: orgId,
        source: 'tiktok_shop',
        platform: 'tiktok_shop',
        external_order_id: o.id,
        sku: 'TTS-ORDER',
        product_id: null,
        product_title: 'Pedido TikTok Shop',
        quantity: o.line_items?.length ?? 1,
        sale_price: total != null && !Number.isNaN(total) ? total : null,
        status: this.mapTtsStatus(o.status),
        buyer_name: o.recipient_address?.name ?? null,
        sold_at: o.create_time ? new Date(o.create_time * 1000).toISOString() : null,
        raw_data: o as unknown as Record<string, unknown>,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source,external_order_id,sku' },
    )
    if (ordErr) this.logger.warn(`[tts] espelho orders falhou (${o.id}): ${ordErr.message}`)
    return !error
  }

  /** Sincroniza UM pedido pelo id (webhook): busca o detalhe via API e faz upsert. */
  async syncOrderById(orgId: string, orderId: string): Promise<boolean> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) return false
    const shopCipher = await this.getShopCipher(orgId)
    const { data: cred } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('shop_id')
      .eq('organization_id', orgId)
      .maybeSingle<{ shop_id: string | null }>()
    const data = await this.ttsRequest<{ orders?: TtsOrder[] }>({
      method: 'GET',
      path: '/order/202309/orders',
      accessToken,
      query: { shop_cipher: shopCipher, ids: orderId },
    })
    const o = data.orders?.[0]
    if (!o) return false
    return this.persistOrder(orgId, cred?.shop_id ?? null, o)
  }

  /** Sincroniza UM produto pelo id (webhook): busca o detalhe e faz upsert. */
  async syncProductById(orgId: string, productId: string): Promise<boolean> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) return false
    const shopCipher = await this.getShopCipher(orgId)
    const { data: cred } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('shop_id')
      .eq('organization_id', orgId)
      .maybeSingle<{ shop_id: string | null }>()
    const p = await this.getProductDetail(productId, shopCipher, accessToken)
    if (!p) return false
    const { error } = await supabaseAdmin.from('tiktok_shop_products').upsert(
      {
        organization_id: orgId,
        shop_id: cred?.shop_id ?? null,
        tts_product_id: p.id,
        title: p.title ?? null,
        status: p.status ?? null,
        sku_count: p.skus?.length ?? 0,
        main_image_url: p.main_images?.[0]?.urls?.[0] ?? null,
        raw: p as unknown as Record<string, unknown>,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,tts_product_id' },
    )
    return !error
  }

  /** Orgs com TikTok Shop conectado (pro cron de reconciliação). */
  async getConnectedOrgIds(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('organization_id')
      .eq('status', 'connected')
    return (data ?? []).map((r) => (r as { organization_id: string }).organization_id)
  }

  // ── Webhook (tempo real) ──────────────────────────────────────────────────

  /** Verifica a assinatura do webhook: HMAC-SHA256(app_secret, app_key + body). */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature || !this.isConfigured()) return false
    const { appKey, appSecret } = this.env()
    const expected = crypto
      .createHmac('sha256', appSecret)
      .update(appKey + rawBody)
      .digest('hex')
    return expected.toLowerCase() === signature.toLowerCase()
  }

  /** Valida o secret embutido na URL do webhook (?key=). Sem secret configurado
   *  no servidor → não bloqueia (confia na assinatura). */
  isWebhookSecretValid(key: string | undefined): boolean {
    const secret = process.env.TIKTOK_SHOP_WEBHOOK_SECRET
    if (!secret) return true
    return key === secret
  }

  private async orgByShopId(shopId: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('organization_id')
      .eq('shop_id', shopId)
      .maybeSingle<{ organization_id: string }>()
    return data?.organization_id ?? null
  }

  /** Processa um evento de webhook. Roteia por order_id/product_id no payload e
   *  faz sync ALVO (re-fetch da entidade via API assinada → upsert). Resolve a
   *  org pelo shop_id. Idempotente (upsert). */
  async handleWebhook(
    payload: TtsWebhookPayload,
  ): Promise<{ handled: boolean; action?: 'order' | 'product' }> {
    const shopId = payload.shop_id != null ? String(payload.shop_id) : null
    const data = payload.data ?? {}
    const orgId = shopId ? await this.orgByShopId(shopId) : null
    if (!orgId) {
      this.logger.warn(`[tts.webhook] shop_id=${shopId} sem org conectada — ignorado`)
      return { handled: false }
    }
    const orderId = (data.order_id ?? data.order_id_str) as string | number | undefined
    const productId = (data.product_id ?? data.product_id_str) as string | number | undefined
    try {
      if (orderId != null) {
        const ok = await this.syncOrderById(orgId, String(orderId))
        this.logger.log(`[tts.webhook] order=${orderId} sync=${ok} type=${payload.type}`)
        return { handled: true, action: 'order' }
      }
      if (productId != null) {
        const ok = await this.syncProductById(orgId, String(productId))
        this.logger.log(`[tts.webhook] product=${productId} sync=${ok} type=${payload.type}`)
        return { handled: true, action: 'product' }
      }
    } catch (e) {
      this.logger.warn(
        `[tts.webhook] processar falhou: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    this.logger.log(`[tts.webhook] type=${payload.type} sem order_id/product_id — ignorado`)
    return { handled: false }
  }

  /** Lista os pedidos já importados (pra UI/validação). */
  async listOrders(orgId: string, limit = 50): Promise<unknown[]> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_orders')
      .select(
        'tts_order_id, order_status, recipient_name, total_amount, currency, line_item_count, tts_create_time, synced_at',
      )
      .eq('organization_id', orgId)
      .order('tts_create_time', { ascending: false, nullsFirst: false })
      .limit(Math.min(limit, 200))
    return data ?? []
  }

  // ── Fase 3: produtos ──────────────────────────────────────────────────────

  /** Detalhe completo do produto (imagem/descrição/preço/categoria). O search
   *  devolve só o produto "leve" (sem imagem/descrição) — pra gerar conteúdo
   *  (que exige foto https) precisamos do detalhe. Falha = null (não-fatal). */
  private async getProductDetail(
    productId: string,
    shopCipher: string,
    accessToken: string,
  ): Promise<TtsProduct | null> {
    try {
      return await this.ttsRequest<TtsProduct>({
        method: 'GET',
        path: `/product/202309/products/${productId}`,
        accessToken,
        query: { shop_cipher: shopCipher },
      })
    } catch (e) {
      this.logger.warn(
        `[tts] detalhe do produto ${productId} falhou: ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
  }

  /** Importa produtos do TikTok Shop → tiktok_shop_products (isolada).
   *  Enriquece cada produto com o DETALHE (imagem/descrição) — necessário pro
   *  Social AI (TS-P4). `enrich=false` pula o detalhe (sync leve/rápido).
   *  Skip incremental: produtos que já têm imagem não re-buscam o detalhe. */
  async importProducts(
    orgId: string,
    maxPages = 4,
    opts: { enrich?: boolean } = {},
  ): Promise<{ imported: number; pages: number; enriched: number }> {
    const enrich = opts.enrich !== false
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)

    const { data: cred } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .select('shop_id')
      .eq('organization_id', orgId)
      .maybeSingle<{ shop_id: string | null }>()
    const shopId = cred?.shop_id ?? null

    // 1) Coleta todos os produtos via search (leve, paginado).
    const all: TtsProduct[] = []
    let pageToken: string | undefined
    let pages = 0
    do {
      const data = await this.ttsRequest<{
        products?: TtsProduct[]
        next_page_token?: string
      }>({
        method: 'POST',
        path: '/product/202309/products/search',
        accessToken,
        query: { shop_cipher: shopCipher, page_size: 50, page_token: pageToken },
        body: {},
      })
      const products = data.products ?? []
      all.push(...products)
      pages++
      pageToken =
        data.next_page_token && products.length > 0 ? data.next_page_token : undefined
    } while (pageToken && pages < maxPages)

    // 2) Quais já têm imagem (pra pular o detalhe em re-syncs).
    const { data: existingRows } = await supabaseAdmin
      .from('tiktok_shop_products')
      .select('tts_product_id, main_image_url')
      .eq('organization_id', orgId)
    const haveImage = new Set(
      (existingRows ?? [])
        .filter((r) => (r as { main_image_url: string | null }).main_image_url)
        .map((r) => (r as { tts_product_id: string }).tts_product_id),
    )

    // 3) Enriquece (concorrência limitada) + upsert.
    let imported = 0
    let enriched = 0
    const CONCURRENCY = 8
    for (let i = 0; i < all.length; i += CONCURRENCY) {
      const chunk = all.slice(i, i + CONCURRENCY)
      await Promise.all(
        chunk.map(async (p) => {
          const skipDetail = !enrich || haveImage.has(p.id)
          const detail = skipDetail
            ? null
            : await this.getProductDetail(p.id, shopCipher, accessToken)
          if (detail) enriched++
          const merged: TtsProduct = detail ?? p
          const mainImg = merged.main_images?.[0]?.urls?.[0] ?? null

          const row: Record<string, unknown> = {
            organization_id: orgId,
            shop_id: shopId,
            tts_product_id: p.id,
            title: merged.title ?? p.title ?? null,
            status: merged.status ?? p.status ?? null,
            sku_count: merged.skus?.length ?? p.skus?.length ?? 0,
            synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          // Só sobrescreve imagem/raw quando temos o detalhe; senão preserva o
          // que já existe (não rebaixa um produto enriquecido pro "leve").
          if (detail) {
            row.main_image_url = mainImg
            row.raw = merged as unknown as Record<string, unknown>
          } else if (!haveImage.has(p.id)) {
            // Primeiro insert sem detalhe (ex.: enrich=false): grava o leve.
            row.main_image_url = mainImg
            row.raw = merged as unknown as Record<string, unknown>
          }

          const { error } = await supabaseAdmin
            .from('tiktok_shop_products')
            .upsert(row, { onConflict: 'organization_id,tts_product_id' })
          if (!error) imported++
        }),
      )
    }

    return { imported, pages, enriched }
  }

  /** Lista os produtos já importados (pra UI/validação + Fase 4). */
  async listProducts(orgId: string, limit = 50): Promise<unknown[]> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_products')
      .select('tts_product_id, title, status, sku_count, main_image_url, synced_at')
      .eq('organization_id', orgId)
      .order('synced_at', { ascending: false })
      .limit(Math.min(limit, 200))
    return data ?? []
  }

  // ── Fase 4: publicar produto — base de PREVIEW/MAPEAMENTO (NÃO publica) ─────
  // Tudo read-only contra o TikTok (categorias/atributos/recomendar). A criação
  // real do anúncio (product/202309/products create + upload imagem) é a fase 2,
  // gated e validada com 1 produto de teste.

  /** Árvore de categorias (pt-BR), filtrável por palavra-chave. Read-only. */
  async getCategories(
    orgId: string,
    opts: { keyword?: string; leafOnly?: boolean; limit?: number } = {},
  ): Promise<Array<{ id: string; name: string; is_leaf: boolean; parent_id: string }>> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    const data = await this.ttsRequest<{
      categories?: Array<{ id: string; local_name: string; is_leaf: boolean; parent_id: string }>
    }>({
      method: 'GET',
      path: '/product/202309/categories',
      accessToken,
      query: { shop_cipher: shopCipher, category_version: 'v2', locale: 'pt-BR' },
    })
    let cats = (data.categories ?? []).map((c) => ({
      id: c.id,
      name: c.local_name,
      is_leaf: c.is_leaf,
      parent_id: c.parent_id,
    }))
    if (opts.leafOnly) cats = cats.filter((c) => c.is_leaf)
    const kw = opts.keyword?.trim().toLowerCase()
    if (kw) cats = cats.filter((c) => (c.name ?? '').toLowerCase().includes(kw))
    return cats.slice(0, opts.limit ?? 50)
  }

  /** Atributos de uma categoria (required/opcional + valores). Read-only. */
  async getCategoryAttributes(
    orgId: string,
    categoryId: string,
  ): Promise<
    Array<{ id: string; name: string; required: boolean; type: string; values: Array<{ id: string; name: string }> }>
  > {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    const data = await this.ttsRequest<{
      attributes?: Array<{
        id: string
        name: string
        is_requried?: boolean
        is_required?: boolean
        type?: string
        values?: Array<{ id: string; name: string }>
      }>
    }>({
      method: 'GET',
      path: `/product/202309/categories/${categoryId}/attributes`,
      accessToken,
      query: { shop_cipher: shopCipher, category_version: 'v2', locale: 'pt-BR' },
    })
    return (data.attributes ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      required: !!(a.is_requried ?? a.is_required),
      type: a.type ?? 'PRODUCT_PROPERTY',
      values: a.values ?? [],
    }))
  }

  /** Recomenda categoria a partir do nome (best-effort; pode não casar). */
  async recommendCategory(
    orgId: string,
    args: { product_name: string; description?: string },
  ): Promise<{ category_id: string | null; message?: string }> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    try {
      const data = await this.ttsRequest<{
        leaf_category_ids?: string[]
        categories?: Array<{ id: string }>
      }>({
        method: 'POST',
        path: '/product/202309/categories/recommend',
        accessToken,
        query: { shop_cipher: shopCipher },
        body: { product_title: args.product_name, description: args.description ?? '' },
      })
      return { category_id: data.leaf_category_ids?.[0] ?? data.categories?.[0]?.id ?? null }
    } catch (e) {
      return { category_id: null, message: e instanceof Error ? e.message : 'sem recomendação' }
    }
  }

  /** PREVIEW de publicação (NÃO publica): mapeia o produto pro payload do TikTok
   *  e lista os atributos obrigatórios que faltam. */
  async previewPublish(
    orgId: string,
    src: {
      product_name: string
      description?: string
      images?: string[]
      price?: number
      sku?: string
      stock?: number
      category_id?: string
    },
  ): Promise<{
    category_id: string | null
    recommended: boolean
    attributes: Array<{ id: string; name: string; required: boolean }>
    missing_required: Array<{ id: string; name: string }>
    draft_payload: Record<string, unknown>
  }> {
    let categoryId = src.category_id ?? null
    let recommended = false
    if (!categoryId) {
      const rec = await this.recommendCategory(orgId, {
        product_name: src.product_name,
        description: src.description,
      })
      categoryId = rec.category_id
      recommended = !!categoryId
    }
    const attrs = categoryId ? await this.getCategoryAttributes(orgId, categoryId) : []
    const missing_required = attrs
      .filter((a) => a.required)
      .map((a) => ({ id: a.id, name: a.name }))
    const draft_payload: Record<string, unknown> = {
      title: src.product_name,
      description: src.description ?? '',
      category_id: categoryId,
      main_images: (src.images ?? []).slice(0, 9).map((url) => ({ url })),
      skus: [
        {
          seller_sku: src.sku ?? '',
          price: { amount: src.price != null ? String(src.price) : '', currency: 'BRL' },
          inventory: [{ quantity: src.stock ?? 0 }],
        },
      ],
    }
    return {
      category_id: categoryId,
      recommended,
      attributes: attrs.map((a) => ({ id: a.id, name: a.name, required: a.required })),
      missing_required,
      draft_payload,
    }
  }

  // ── Fase 4b: PUBLICAR de verdade (contrato validado ao vivo) ───────────────

  /** Armazém de vendas da loja (necessário no estoque do create). */
  private async getWarehouseId(orgId: string): Promise<string | null> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) return null
    const data = await this.ttsRequest<{ warehouses?: Array<{ id: string; type?: string }> }>({
      method: 'GET',
      path: '/logistics/202309/warehouses',
      accessToken,
    })
    const whs = data.warehouses ?? []
    return whs.find((w) => w.type === 'SALES_WAREHOUSE')?.id ?? whs[0]?.id ?? null
  }

  /** Sobe UMA imagem (baixa a URL → upload pro CDN do TikTok). Multipart: a
   *  assinatura NÃO inclui corpo e o endpoint NÃO aceita shop_cipher (erro
   *  36009004). Devolve o `uri` pra usar em main_images. */
  private async uploadImageToTikTok(
    imageUrl: string,
    accessToken: string,
  ): Promise<string | null> {
    try {
      const img = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000) })
      if (!img.ok) return null
      const buf = Buffer.from(await img.arrayBuffer())
      const { appKey, appSecret } = this.env()
      const path = '/product/202309/images/upload'
      const query: Record<string, string | number> = {
        app_key: appKey,
        timestamp: Math.floor(Date.now() / 1000),
      }
      const sign = signTikTokShop({ appSecret, path, query })
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) qs.set(k, String(v))
      qs.set('sign', sign)
      const fd = new FormData()
      fd.append('data', new Blob([buf]), 'image.jpg')
      fd.append('use_case', 'MAIN_IMAGE')
      const res = await fetch(`${TTS_API_BASE}${path}?${qs.toString()}`, {
        method: 'POST',
        headers: { 'x-tts-access-token': accessToken },
        body: fd,
        signal: AbortSignal.timeout(30_000),
      })
      const json = (await res.json().catch(() => ({}))) as {
        code?: number
        data?: { uri?: string }
      }
      return json.code === 0 ? (json.data?.uri ?? null) : null
    } catch {
      return null
    }
  }

  /** PUBLICA um produto no TikTok Shop (cria anúncio). Sobe as imagens, monta o
   *  payload e cria. O caller (IA Criativo) passa os campos já resolvidos do
   *  listing/produto. Idempotência fica a cargo do caller (cada chamada cria). */
  async publishProduct(
    orgId: string,
    input: {
      title: string
      description?: string
      category_id: string
      image_urls: string[]
      price: number
      stock?: number
      sku?: string
      package_weight_kg?: number
      package_dimensions_cm?: { length: number; width: number; height: number }
      dry_run?: boolean
    },
  ): Promise<{ product_id: string | null; uploaded_images: number; dry_run?: boolean; skus?: unknown }> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    if (!input.category_id) throw new BadRequestException('category_id é obrigatório')
    if (!input.title?.trim()) throw new BadRequestException('título é obrigatório')
    if (!input.image_urls?.length) throw new BadRequestException('pelo menos 1 imagem é obrigatória')
    if (input.price == null) throw new BadRequestException('preço é obrigatório')

    const shopCipher = await this.getShopCipher(orgId)
    const warehouseId = await this.getWarehouseId(orgId)
    if (!warehouseId) throw new BadRequestException('Nenhum armazém encontrado na loja')

    const uris: string[] = []
    for (const url of input.image_urls.slice(0, 9)) {
      const uri = await this.uploadImageToTikTok(url, accessToken)
      if (uri) uris.push(uri)
    }
    if (!uris.length) throw new BadRequestException('Falha ao subir as imagens pro TikTok')

    const dim = input.package_dimensions_cm ?? { length: 20, width: 20, height: 15 }
    const body = {
      title: input.title,
      description: `<p>${(input.description ?? input.title).replace(/</g, '&lt;')}</p>`,
      category_id: input.category_id,
      main_images: uris.map((uri) => ({ uri })),
      package_weight: { value: String(input.package_weight_kg ?? 1), unit: 'KILOGRAM' },
      package_dimensions: {
        length: String(dim.length),
        width: String(dim.width),
        height: String(dim.height),
        unit: 'CENTIMETER',
      },
      skus: [
        {
          seller_sku: input.sku ?? '',
          inventory: [{ warehouse_id: warehouseId, quantity: input.stock ?? 1 }],
          price: { amount: String(input.price), currency: 'BRL' },
        },
      ],
    }

    if (input.dry_run) {
      return { product_id: null, uploaded_images: uris.length, dry_run: true }
    }

    const data = await this.ttsRequest<{ product_id: string; skus?: unknown }>({
      method: 'POST',
      path: '/product/202309/products',
      accessToken,
      query: { shop_cipher: shopCipher },
      body,
    })
    this.logger.log(`[tts.publish] produto criado ${data.product_id} (${uris.length} imgs)`)
    return { product_id: data.product_id, uploaded_images: uris.length, skus: data.skus }
  }

  // ── Página de Anúncios TikTok (leitura) ───────────────────────────────────

  /** Mapeia o status do PRODUTO TikTok pras abas (vocabulário do ML). */
  private ttStatusTab(s?: string | null): TkTab {
    switch ((s ?? '').toUpperCase()) {
      case 'ACTIVATE':
        return 'active'
      case 'SELLER_DEACTIVATED':
      case 'PLATFORM_DEACTIVATED':
      case 'FREEZE':
        return 'paused'
      case 'DELETED':
        return 'closed'
      case 'PENDING':
      case 'DRAFT':
      case 'FAILED':
      default:
        return 'under_review'
    }
  }

  /** Folha da árvore de categorias (nome amigável). */
  private leafCategory(chains?: TtsProduct['category_chains']): string | null {
    if (!chains?.length) return null
    const leaf = chains.find((c) => c.is_leaf)
    return (leaf ?? chains[chains.length - 1])?.local_name ?? null
  }

  /** Lê tiktok_shop_products (raw) e achata em linhas no nível do SKU.
   *  Dataset pequeno (centenas) → filtro/paginação em memória. */
  private async buildListingRows(orgId: string): Promise<TkListing[]> {
    const { data } = await supabaseAdmin
      .from('tiktok_shop_products')
      .select('tts_product_id, title, status, main_image_url, synced_at, raw')
      .eq('organization_id', orgId)
      .order('synced_at', { ascending: false })
      .limit(500)

    const rows: TkListing[] = []
    for (const r of (data ?? []) as Array<{
      tts_product_id: string
      title: string | null
      status: string | null
      main_image_url: string | null
      synced_at: string | null
      raw: TtsProduct | null
    }>) {
      const raw = r.raw ?? null
      const skus = raw?.skus ?? []
      const category = this.leafCategory(raw?.category_chains)
      const multi = skus.length > 1

      if (skus.length === 0) {
        // Produto sem detalhe ainda (search leve): linha mínima.
        rows.push({
          tts_product_id: r.tts_product_id,
          sku_id: r.tts_product_id,
          seller_sku: null,
          title: r.title ?? '(sem título)',
          variation_name: null,
          status: r.status,
          sku_status: null,
          price: null,
          currency: null,
          stock: 0,
          warehouse_id: null,
          image: r.main_image_url,
          category,
          sku_count: 0,
          synced_at: r.synced_at,
        })
        continue
      }

      for (const sku of skus) {
        const variationName = multi
          ? (sku.sales_attributes ?? [])
              .map((a) => a.value_name)
              .filter(Boolean)
              .join(' / ') || null
          : null
        const priceStr = sku.price?.sale_price ?? sku.price?.tax_exclusive_price ?? null
        const price = priceStr != null ? Number(priceStr) : null
        const stock = (sku.inventory ?? []).reduce(
          (sum, inv) => sum + (Number(inv.quantity) || 0),
          0,
        )
        rows.push({
          tts_product_id: r.tts_product_id,
          sku_id: sku.id,
          seller_sku: sku.seller_sku ?? null,
          title: r.title ?? raw?.title ?? '(sem título)',
          variation_name: variationName,
          status: r.status ?? raw?.status ?? null,
          sku_status: sku.status_info?.status ?? null,
          price: price != null && !Number.isNaN(price) ? price : null,
          currency: sku.price?.currency ?? null,
          stock,
          warehouse_id: sku.inventory?.[0]?.warehouse_id ?? null,
          image: sku.sku_img?.urls?.[0] ?? r.main_image_url,
          category,
          sku_count: skus.length,
          synced_at: r.synced_at,
        })
      }
    }
    return rows
  }

  /** Lista anúncios TikTok (nível SKU) com filtro de aba + busca + paginação. */
  async listListings(
    orgId: string,
    opts: { status?: string; q?: string; offset?: number; limit?: number } = {},
  ): Promise<{ items: TkListing[]; total: number }> {
    const all = await this.buildListingRows(orgId)
    const tab = (opts.status ?? '').toLowerCase()
    const q = (opts.q ?? '').trim().toLowerCase()

    let filtered = all
    if (tab && tab !== 'all') {
      filtered = filtered.filter((r) => this.ttStatusTab(r.status) === tab)
    }
    if (q) {
      filtered = filtered.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          (r.seller_sku ?? '').toLowerCase().includes(q) ||
          r.tts_product_id.includes(q),
      )
    }

    const total = filtered.length
    const offset = Math.max(0, opts.offset ?? 0)
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 100)
    return { items: filtered.slice(offset, offset + limit), total }
  }

  /** Contadores por aba (mesmo shape do ML). */
  async listingCounts(
    orgId: string,
  ): Promise<{ active: number; paused: number; closed: number; under_review: number }> {
    const all = await this.buildListingRows(orgId)
    const counts = { active: 0, paused: 0, closed: 0, under_review: 0 }
    for (const r of all) counts[this.ttStatusTab(r.status)]++
    return counts
  }
}
