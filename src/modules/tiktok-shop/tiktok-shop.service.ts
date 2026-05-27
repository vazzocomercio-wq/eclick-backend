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

interface TtsProduct {
  id: string
  title?: string
  status?: string
  skus?: unknown[]
  main_images?: Array<{ uri?: string; urls?: string[] }>
  // Campos extras que SÓ vêm no detalhe (GET /product/202309/products/{id}),
  // não no search. Opcionais porque o search devolve só o produto "leve".
  description?: string
  category_chains?: Array<{ local_name?: string; is_leaf?: boolean }>
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

        // Espelha no modelo UNIFICADO `orders` (tela central de pedidos, junto
        // com ML/manual). product_id=NULL → ZERO impacto no estoque (o cron de
        // estoque só lê platform='mercadolivre' + product_id not null).
        // source/platform='tiktok_shop' isola totalmente do ML.
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

        if (!error) imported++
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
}
