import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  forwardRef,
} from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { encryptConfig, decryptConfig } from '../marketplace/crypto.util'
import { signTikTokShop } from './tiktok-shop-sign.util'
import { StockService } from '../stock/stock.service'
import { ChannelSettingsService } from '../channel-settings/channel-settings.service'
import { computeContributionMargin, round2 } from '../../common/margin'
import { resolveCatalogProductIdBySku, linkProductListing } from '../../common/product-listing-link'

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
const TTS_TOKEN_REFRESH = 'https://auth.tiktok-shops.com/api/v2/token/refresh'
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

interface TtsOrderLineItem {
  id?: string
  sku_id?: string
  seller_sku?: string
  product_id?: string
  sku_name?: string
  product_name?: string
  sale_price?: string
  original_price?: string
}

interface TtsOrderPayment {
  total_amount?: string
  sub_total?: string
  shipping_fee?: string
  seller_discount?: string
  platform_discount?: string
  original_shipping_fee?: string
  shipping_fee_platform_discount?: string
  currency?: string
}

interface TtsOrder {
  id: string
  status?: string
  buyer_message?: string
  recipient_address?: { name?: string }
  payment?: TtsOrderPayment
  // line_items do TikTok são POR-UNIDADE (cada unidade = 1 entrada; qtd de um
  // SKU = nº de entradas com aquele sku_id). sku_id == product_listings.listing_id.
  line_items?: TtsOrderLineItem[]
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

/** status cru do produto TikTok (202309) → vocabulário comum do painel de
 *  publicações. ACTIVATE = no ar; DEACTIVATED/FREEZE = pausado; PENDING/REVIEW =
 *  em análise; DRAFT/FAILED = inativo; DELETED = removido. */
function normalizeTiktokStatus(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.toUpperCase()
  if (s === 'ACTIVATE' || s === 'ACTIVE' || s === 'LIVE') return 'active'
  if (s.includes('DEACTIVAT') || s === 'FREEZE' || s === 'SUSPEND') return 'paused'
  if (s === 'PENDING' || s.includes('REVIEW') || s === 'AUDITING') return 'under_review'
  if (s.includes('DELETE')) return 'closed'
  if (s === 'DRAFT' || s === 'FAILED') return 'inactive'
  return 'inactive'
}

@Injectable()
export class TikTokShopService {
  private readonly logger = new Logger(TikTokShopService.name)

  // forwardRef: StockModule importa TikTokShopModule (TT-4a push) e vice-versa
  // (TT-4b pull) — ciclo resolvido pelo Nest.
  constructor(
    @Inject(forwardRef(() => StockService))
    private readonly stockService: StockService,
    private readonly channelSettings: ChannelSettingsService,
  ) {}

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
      .select('credentials_encrypted, access_expires_at, refresh_expires_at')
      .eq('organization_id', orgId)
      .maybeSingle<{ credentials_encrypted: string; access_expires_at: string | null; refresh_expires_at: string | null }>()
    if (!data?.credentials_encrypted) return null
    const dec = decryptConfig(data.credentials_encrypted)
    const token = typeof dec?.access_token === 'string' ? dec.access_token : null
    const refreshToken = typeof dec?.refresh_token === 'string' ? dec.refresh_token : null

    // RENOVA on-demand: o access token do TikTok Shop dura ~7 dias; sem refresh
    // ele morre e TODAS as chamadas (categorias/publish) voltam vazias/erro.
    // Se está vencido (ou vence em <5min) e há refresh_token válido, renova.
    const accessExp = data.access_expires_at ? new Date(data.access_expires_at).getTime() : 0
    const nearExpiry = !accessExp || accessExp - Date.now() < 5 * 60 * 1000
    const refreshExp = data.refresh_expires_at ? new Date(data.refresh_expires_at).getTime() : 0
    const refreshValid = !!refreshToken && (!refreshExp || refreshExp > Date.now())
    if (nearExpiry && refreshValid) {
      try {
        return await this.refreshAccessToken(orgId, refreshToken as string)
      } catch (e) {
        this.logger.warn(`[tiktok] refresh do token falhou — usa o atual: ${(e as Error)?.message}`)
      }
    }
    return token
  }

  /** Renova o access token via refresh_token (TikTok Shop). Atualiza SÓ os
   *  campos de token — NÃO mexe em open_id/shop_cipher/seller (o refresh pode
   *  não devolvê-los, e zerá-los quebraria a resolução da loja). */
  private async refreshAccessToken(orgId: string, refreshToken: string): Promise<string | null> {
    const { appKey, appSecret } = this.env()
    const params = new URLSearchParams({
      app_key: appKey,
      app_secret: appSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    })
    const res = await fetch(`${TTS_TOKEN_REFRESH}?${params.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    })
    const json = (await res.json()) as TtsTokenResponse
    if (!res.ok || json.code !== 0 || !json.data?.access_token) {
      throw new BadRequestException(`TikTok Shop refresh falhou: ${json.message ?? `HTTP ${res.status}`} (code ${json.code ?? '?'})`)
    }
    const d = json.data
    const credentials_encrypted = encryptConfig({
      access_token: d.access_token,
      refresh_token: d.refresh_token ?? refreshToken, // mantém o atual se não vier novo
    })
    if (!credentials_encrypted) throw new BadRequestException('Falha ao cifrar credenciais TikTok renovadas')
    const patch: Record<string, unknown> = {
      credentials_encrypted,
      status: 'connected',
      updated_at: new Date().toISOString(),
    }
    if (d.access_token_expire_in)  patch.access_expires_at  = new Date(d.access_token_expire_in * 1000).toISOString()
    if (d.refresh_token_expire_in) patch.refresh_expires_at = new Date(d.refresh_token_expire_in * 1000).toISOString()
    const { error } = await supabaseAdmin
      .from('tiktok_shop_credentials')
      .update(patch)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Falha ao salvar token TikTok renovado: ${error.message}`)
    this.logger.log(`[tiktok] access token renovado p/ org=${orgId}`)
    return d.access_token ?? null
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
    applyStock = false,
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

    // Espelho no `orders` unificado: TT-5b mudou pra 1 ROW POR SKU VENDIDO
    // (não mais 1 marker agregado 'TTS-ORDER'). Custos populados:
    // platform_fee (comissão TikTok estimada via channel-settings, já que a
    // API não devolve no pedido — só em Settlement), shipping_cost (frete real
    // pago pelo vendedor, rateado por SKU), cost_price/tax/margem (do produto
    // vinculado, quando há vínculo). Permite dashboards/financeiro verem
    // margem real por produto+canal.
    await this.mirrorOrderLines(orgId, o).catch((e) =>
      this.logger.warn(`[tts] espelho orders falhou (${o.id}): ${e instanceof Error ? e.message : String(e)}`),
    )

    // TT-4b (PULL): só no caminho do WEBHOOK (venda nova em tempo real) e com a
    // flag ligada. NUNCA no import/cron — evita baixar retroativamente pedidos
    // históricos. O espelho em `orders` segue product_id=NULL (a baixa é feita
    // aqui, explícita, via applySaleMovement idempotente).
    if (applyStock && this.isOrderDecrementEnabled()) {
      await this.applyOrderStockMovement(orgId, o).catch((e) =>
        this.logger.warn(
          `[tts.stock] baixa do pedido ${o.id} falhou: ${e instanceof Error ? e.message : String(e)}`,
        ),
      )
    }
    return !error
  }

  /** Flag de segurança: venda no TikTok só baixa o estoque mestre quando ligado. */
  isOrderDecrementEnabled(): boolean {
    return process.env.TIKTOK_ORDER_DECREMENT === 'on'
  }

  /** Baixa o estoque mestre a partir das linhas do pedido TikTok. line_items são
   *  por-unidade → qtd por sku_id = nº de linhas. Resolve sku_id (=listing_id)
   *  pros produtos vinculados e chama applySaleMovement (idempotente; recalc
   *  re-propaga pro ML + TikTok). Cancelamento/refund estorna. */
  private async applyOrderStockMovement(orgId: string, o: TtsOrder): Promise<void> {
    const items = o.line_items ?? []
    if (!items.length) return
    const qtyBySku = new Map<string, number>()
    for (const it of items) {
      if (!it.sku_id) continue
      qtyBySku.set(it.sku_id, (qtyBySku.get(it.sku_id) ?? 0) + 1)
    }
    if (qtyBySku.size === 0) return

    const { data: links } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, product_id')
      .eq('platform', 'tiktok_shop')
      .eq('is_active', true)
      .in('listing_id', [...qtyBySku.keys()])
    if (!links?.length) return

    const status = this.mapTtsStatus(o.status)
    for (const l of links as Array<{ listing_id: string; product_id: string }>) {
      const qty = qtyBySku.get(l.listing_id) ?? 0
      if (qty <= 0) continue
      const r = await this.stockService.applySaleMovement({
        productId: l.product_id,
        quantity: qty,
        externalOrderId: String(o.id),
        status,
        channel: 'tiktok_shop',
      })
      this.logger.log(
        `[tts.stock] pedido=${o.id} sku=${l.listing_id} produto=${l.product_id} qty=${qty} status=${status} → ${r}`,
      )
    }
  }

  /** TT-5b — espelha o pedido TikTok em `orders` no nível do SKU vendido, com
   *  decomposição de custos (platform_fee/shipping_cost/cost_price/tax_amount/
   *  margem) pra alimentar dashboards e financeiro. Idempotente via upsert
   *  por (source, external_order_id, sku). Cada canal tem seus custos próprios:
   *
   *  - platform_fee: comissão TikTok ESTIMADA (sub_total × commission_pct/100,
   *    rateada por SKU) — a API do TikTok só devolve a comissão real em
   *    Settlement (pós-faturamento). channel-settings.commission_pct é a
   *    referência (configurável por org).
   *  - shipping_cost: o frete REAL pago pelo vendedor já descontados os
   *    subsídios da plataforma (payment.shipping_fee), rateado por SKU pelo
   *    share no sub_total.
   *  - cost_price / tax_amount / margem: vêm do produto VINCULADO (quando há
   *    link em product_listings). Sem vínculo, ficam NULL (revenue conta;
   *    margem só após vincular).
   */
  private async mirrorOrderLines(orgId: string, o: TtsOrder): Promise<void> {
    const items = o.line_items ?? []
    if (!items.length) return

    // Agrupa por (seller_sku || sku_id) — cada line item = 1 unidade no TikTok.
    type Group = {
      sku: string
      sku_id: string
      product_title: string
      qty: number
      sale_total: number
    }
    const groups = new Map<string, Group>()
    for (const it of items) {
      const sku = (it.seller_sku ?? '').trim() || (it.sku_id ?? '').trim()
      if (!sku) continue
      const g = groups.get(sku) ?? {
        sku,
        sku_id: it.sku_id ?? '',
        product_title: it.product_name ?? it.sku_name ?? '(produto)',
        qty: 0,
        sale_total: 0,
      }
      g.qty += 1
      g.sale_total += Number(it.sale_price ?? 0) || 0
      groups.set(sku, g)
    }
    if (groups.size === 0) return

    // Resolve produtos vinculados (custos/imposto) por sku_id.
    type LinkRow = {
      listing_id: string
      product_id: string
      products: {
        cost_price: number | null
        tax_percentage: number | null
        tax_on_freight: boolean | null
      } | null
    }
    const linkBySkuId = new Map<
      string,
      { product_id: string; cost_price: number | null; tax_pct: number; tax_on_freight: boolean }
    >()
    const skuIds = [...groups.values()].map((g) => g.sku_id).filter(Boolean)
    if (skuIds.length) {
      const { data } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id, product_id, products(cost_price, tax_percentage, tax_on_freight)')
        .eq('platform', 'tiktok_shop')
        .eq('is_active', true)
        .in('listing_id', skuIds)
      for (const r of (data ?? []) as unknown as LinkRow[]) {
        const prod = r.products
        linkBySkuId.set(r.listing_id, {
          product_id: r.product_id,
          cost_price: prod?.cost_price ?? null,
          tax_pct: Number(prod?.tax_percentage ?? 0) || 0,
          tax_on_freight: Boolean(prod?.tax_on_freight),
        })
      }
    }

    // Custos do canal — comissão configurada da org pro tiktok_shop.
    const commissionPct = await this.channelSettings.getCommissionPct(orgId, 'tiktok_shop', 0)

    // Sub_total e frete vindos do payment do pedido (rateio por SKU).
    const subTotalAll =
      Number(o.payment?.sub_total ?? 0) ||
      [...groups.values()].reduce((s, g) => s + g.sale_total, 0)
    const shippingFee = Number(o.payment?.shipping_fee ?? 0) || 0
    const status = this.mapTtsStatus(o.status)
    const soldAt = o.create_time ? new Date(o.create_time * 1000).toISOString() : null
    const buyer = o.recipient_address?.name ?? null
    const nowIso = new Date().toISOString()

    // Upsert 1 row por SKU vendido.
    for (const g of groups.values()) {
      const link = linkBySkuId.get(g.sku_id) ?? null
      const sale_price = round2(g.sale_total)
      const platform_fee = round2(sale_price * commissionPct / 100)
      const shipping_cost = subTotalAll > 0 ? round2(shippingFee * sale_price / subTotalAll) : 0
      const cost_price = link?.cost_price != null ? round2(Number(link.cost_price) * g.qty) : null

      let tax_amount: number | null = null
      let contribution_margin: number | null = null
      let contribution_margin_pct: number | null = null
      if (cost_price != null) {
        const m = computeContributionMargin({
          price: sale_price,
          saleFee: platform_fee,
          shipping: shipping_cost,
          cost: cost_price,
          taxPercentage: link?.tax_pct ?? 0,
          taxOnFreight: link?.tax_on_freight ?? false,
        })
        tax_amount = m.taxAmount
        contribution_margin = m.contributionMargin
        contribution_margin_pct = m.contributionMarginPct
      }
      // Lucro bruto = receita − tarifa − frete (antes de custo/imposto).
      const gross_profit = round2(sale_price - platform_fee - shipping_cost)

      const { error } = await supabaseAdmin.from('orders').upsert(
        {
          organization_id: orgId,
          source: 'tiktok_shop',
          platform: 'tiktok_shop',
          external_order_id: o.id,
          sku: g.sku,
          product_id: link?.product_id ?? null,
          product_title: g.product_title,
          quantity: g.qty,
          sale_price,
          platform_fee,
          shipping_cost,
          cost_price,
          tax_amount,
          gross_profit,
          contribution_margin,
          contribution_margin_pct,
          status,
          buyer_name: buyer,
          sold_at: soldAt,
          raw_data: o as unknown as Record<string, unknown>,
          updated_at: nowIso,
        },
        { onConflict: 'source,external_order_id,sku' },
      )
      if (error) {
        this.logger.warn(`[tts.mirror] sku=${g.sku} pedido=${o.id}: ${error.message}`)
      }
    }
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
    // Webhook = venda nova em tempo real → aplica a baixa de estoque (gateada).
    return this.persistOrder(orgId, cred?.shop_id ?? null, o, true)
  }

  /** Sync de confirmação — status atual de 1 produto, normalizado pro
   *  vocabulário do painel de publicações (active/paused/closed/under_review/
   *  inactive). Usado pela esteira IA Criativo. Lança se a loja não estiver
   *  conectada (o caller faz soft-fallback). */
  async getListingStatus(orgId: string, productId: string): Promise<{ raw: string | null; normalized: string | null }> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    const p = await this.getProductDetail(productId, shopCipher, accessToken)
    const raw = p?.status ?? null
    return { raw, normalized: normalizeTiktokStatus(raw) }
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

  // ── GEO Optimizer: ler + editar título/descrição do anúncio ────────────────

  /** Título + descrição ATUAIS do produto, lidos AO VIVO do TikTok. Usado pelo
   *  GEO Optimizer pra tirar o snapshot (rollback) antes de publicar. */
  async getProductEditable(
    orgId: string,
    productId: string,
  ): Promise<{ title: string; description: string } | null> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    const p = await this.getProductDetail(productId, shopCipher, accessToken)
    if (!p) return null
    return { title: p.title ?? '', description: p.description ?? '' }
  }

  /** Edição PARCIAL do produto: atualiza SÓ os campos enviados; o resto do
   *  anúncio (preço/estoque/imagens/atributos) fica intacto (atômico — se a API
   *  recusar, nada muda). Usado pelo GEO Optimizer pra publicar o título/descrição
   *  reescritos. ALTO RISCO: mexe no anúncio real → sempre gated + versionado
   *  pelo publisher (rollback disponível). */
  async partialEditProduct(
    orgId: string,
    productId: string,
    fields: { title?: string; description?: string },
  ): Promise<void> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    const body: Record<string, unknown> = {}
    if (fields.title != null && fields.title !== '') body.title = fields.title
    if (fields.description != null && fields.description !== '') body.description = fields.description
    if (Object.keys(body).length === 0) throw new BadRequestException('Nada pra editar no anúncio.')
    await this.ttsRequest({
      method: 'POST',
      path: `/product/202309/products/${productId}/partial_edit`,
      accessToken,
      query: { shop_cipher: shopCipher },
      body,
    })
    this.logger.log(`[tts] partial_edit product=${productId} campos=${Object.keys(body).join('+')}`)
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
    const all = (data.categories ?? []).map((c) => ({
      id: c.id,
      name: c.local_name,
      is_leaf: c.is_leaf,
      parent_id: c.parent_id,
    }))
    let cats = all
    const kw = opts.keyword?.trim().toLowerCase()
    if (kw) {
      // casa o nome (folha OU PAI) e inclui também os DESCENDENTES das categorias
      // que casaram. Assim "ilumi" casa o pai "Iluminação" e traz as folhas
      // embaixo dele (antes o filtro de folhas escondia o pai → "nada encontrado").
      const childrenByParent = new Map<string, typeof all>()
      for (const c of all) {
        const arr = childrenByParent.get(c.parent_id) ?? []
        arr.push(c)
        childrenByParent.set(c.parent_id, arr)
      }
      const keep = new Set<string>(all.filter((c) => (c.name ?? '').toLowerCase().includes(kw)).map((c) => c.id))
      const queue = [...keep]
      while (queue.length) {
        const pid = queue.shift() as string
        for (const child of childrenByParent.get(pid) ?? []) {
          if (!keep.has(child.id)) { keep.add(child.id); queue.push(child.id) }
        }
      }
      cats = all.filter((c) => keep.has(c.id))
    }
    if (opts.leafOnly) cats = cats.filter((c) => c.is_leaf)
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
    // /logistics/202309/warehouses EXIGE shop_cipher (erro 106013 sem ele),
    // igual aos endpoints de pedido/produto — o ttsRequest não injeta sozinho.
    const shopCipher = await this.getShopCipher(orgId)
    const data = await this.ttsRequest<{ warehouses?: Array<{ id: string; type?: string }> }>({
      method: 'GET',
      path: '/logistics/202309/warehouses',
      accessToken,
      query: { shop_cipher: shopCipher },
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
      // Atributos do IA Criativo (formato ML: [{id, value_name, value_id}]) —
      // mapeados pros atributos/marca do TikTok. Opcional.
      ml_attributes?: Array<{ id: string; value_name?: string; value_id?: string }>
      brand_name?: string
      // IDs do anúncio do IA Criativo pra registrar em creative_publications.
      listing_id?: string
      creative_product_id?: string
      dry_run?: boolean
    },
  ): Promise<{
    product_id: string | null
    uploaded_images: number
    mapped_attributes?: number
    brand_id?: string | null
    dry_run?: boolean
    skus?: unknown
  }> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    if (!input.category_id) throw new BadRequestException('category_id é obrigatório')
    if (!input.title?.trim()) throw new BadRequestException('título é obrigatório')
    if (!input.image_urls?.length) throw new BadRequestException('pelo menos 1 imagem é obrigatória')
    if (input.price == null) throw new BadRequestException('preço é obrigatório')

    // Idempotência: se este anúncio (listing) já tem publicação TikTok
    // 'published', NÃO cria outro produto — evita duplicar por duplo-clique.
    if (input.listing_id && !input.dry_run) {
      const { data: dup } = await supabaseAdmin
        .from('creative_publications')
        .select('external_id')
        .eq('listing_id', input.listing_id)
        .eq('marketplace', 'tiktok_shop')
        .eq('status', 'published')
        .limit(1)
        .maybeSingle<{ external_id: string | null }>()
      if (dup?.external_id) {
        throw new BadRequestException(
          `Este anúncio já foi publicado no TikTok Shop (produto ${dup.external_id}). Recarregue a página.`,
        )
      }
    }

    const shopCipher = await this.getShopCipher(orgId)
    const warehouseId = await this.getWarehouseId(orgId)
    if (!warehouseId) throw new BadRequestException('Nenhum armazém encontrado na loja')

    const uris: string[] = []
    for (const url of input.image_urls.slice(0, 9)) {
      const uri = await this.uploadImageToTikTok(url, accessToken)
      if (uri) uris.push(uri)
    }
    if (!uris.length) throw new BadRequestException('Falha ao subir as imagens pro TikTok')

    // Mapeia atributos ML → TikTok + resolve a marca (reusa o que o IA Criativo
    // já cadastrou pro ML — não redigita nada).
    const productAttributes = await this.mapMlAttributesToTikTok(
      orgId,
      input.category_id,
      input.ml_attributes ?? [],
    )
    const brandName =
      input.brand_name ??
      input.ml_attributes?.find((a) => a.id === 'BRAND')?.value_name
    const brandId = await this.resolveTikTokBrandId(orgId, brandName)

    const dim = input.package_dimensions_cm ?? { length: 20, width: 20, height: 15 }
    const body: Record<string, unknown> = {
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
    if (productAttributes.length) body.product_attributes = productAttributes
    if (brandId) body.brand_id = brandId

    if (input.dry_run) {
      return {
        product_id: null,
        uploaded_images: uris.length,
        mapped_attributes: productAttributes.length,
        brand_id: brandId,
        dry_run: true,
      }
    }

    const data = await this.ttsRequest<{ product_id: string; skus?: unknown }>({
      method: 'POST',
      path: '/product/202309/products',
      accessToken,
      query: { shop_cipher: shopCipher },
      body,
    })
    this.logger.log(
      `[tts.publish] produto criado ${data.product_id} (${uris.length} imgs, ${productAttributes.length} attrs, brand=${brandId ?? '-'})`,
    )
    // VÍNCULO anúncio↔produto em product_listings (CHAVE = SKU) — o motor de
    // estoque unificado propaga estoque pro TikTok por aqui. Sem isso, o anúncio
    // nasce solto do catálogo. Fail-isolated.
    if (data.product_id) {
      try {
        const catalogId = await resolveCatalogProductIdBySku(orgId, { sku: input.sku })
        if (catalogId) {
          const res = await linkProductListing({
            platform:    'tiktok_shop',
            listingId:   String(data.product_id),
            productId:   catalogId,
            accountId:   null,
            variationId: null,
            title:       input.title,
            price:       input.price,
          })
          this.logger.log(`[tts.publish] vínculo product_listings ${res}: ${data.product_id} → produto ${catalogId}`)
          // Aplica a REGRA CENTRAL de estoque (físico+virtual, pausa quando o
          // físico zera) ao anúncio recém-nascido — o recalc empurra o
          // estoque-regra pro TikTok (e re-sincroniza os irmãos). Sem regra ligada,
          // faz o clássico. Fire-and-forget: não bloqueia a resposta do publish.
          void this.stockService.recalcAndPropagate(catalogId, 'creative_tiktok_publish')
            .catch(e => this.logger.warn(`[tts.publish] recalc estoque pós-publish falhou: ${(e as Error)?.message}`))
        } else {
          this.logger.log(`[tts.publish] sem catálogo por SKU (${input.sku ?? '—'}) — anúncio ${data.product_id} fica sem vínculo de estoque`)
        }
      } catch (e) {
        this.logger.warn(`[tts.publish] vínculo product_listings falhou: ${(e as Error)?.message}`)
      }
    }

    // Registra em creative_publications (NÃO-FATAL) → aparece na lista
    // "Publicações desse anúncio" junto com o ML. Precisa dos FKs do front.
    if (input.listing_id && input.creative_product_id && data.product_id) {
      try {
        await supabaseAdmin.from('creative_publications').insert({
          organization_id: orgId,
          listing_id:      input.listing_id,
          product_id:      input.creative_product_id,
          marketplace:     'tiktok_shop',
          status:          'published',
          idempotency_key: crypto.randomUUID(),
          price:           input.price > 0 ? input.price : null,
          external_id:     String(data.product_id),
          published_at:    new Date().toISOString(),
        })
      } catch (e) {
        this.logger.warn(`[tts.publish] registro creative_publications falhou: ${(e as Error)?.message}`)
      }
    }
    return {
      product_id: data.product_id,
      uploaded_images: uris.length,
      mapped_attributes: productAttributes.length,
      brand_id: brandId,
      skus: data.skus,
    }
  }

  /** Marcas do catálogo TikTok (filtra por nome). Read-only. */
  async getBrands(
    orgId: string,
    opts: { keyword?: string } = {},
  ): Promise<Array<{ id: string; name: string }>> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    const data = await this.ttsRequest<{ brands?: Array<{ id: string; name: string }> }>({
      method: 'GET',
      path: '/product/202309/brands',
      accessToken,
      query: {
        shop_cipher: shopCipher,
        category_version: 'v2',
        page_size: 50,
        brand_name: opts.keyword,
      },
    })
    return data.brands ?? []
  }

  /** normaliza p/ comparar nomes (lower + sem acento). */
  private norm(s?: string): string {
    return (s ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
  }

  /** De-para semântico: id de atributo ML → palavras-chave do nome no TikTok. */
  private static readonly ML_TO_TT_ATTR: Record<string, string[]> = {
    VOLTAGE: ['tensao', 'voltage'],
    POWER: ['potencia', 'power'],
    MATERIALS: ['material'],
    COLOR: ['cor'],
    MAIN_COLOR: ['cor'],
  }

  /** Mapeia atributos do IA Criativo (formato ML) → product_attributes do TikTok.
   *  Casa o atributo por nome e o valor pela lista de valores da categoria
   *  (enum → value_id; sem enum → free-text). De-dup por atributo TikTok. Valor
   *  enum sem match é PULADO (não manda valor inválido). */
  private async mapMlAttributesToTikTok(
    orgId: string,
    categoryId: string,
    mlAttributes: Array<{ id: string; value_name?: string; value_id?: string }>,
  ): Promise<Array<{ id: string; values: Array<{ id?: string; name: string }> }>> {
    if (!mlAttributes?.length) return []
    let catAttrs: Array<{ id: string; name: string; values: Array<{ id: string; name: string }> }>
    try {
      catAttrs = await this.getCategoryAttributes(orgId, categoryId)
    } catch {
      return []
    }
    const out: Array<{ id: string; values: Array<{ id?: string; name: string }> }> = []
    const seen = new Set<string>()
    for (const ml of mlAttributes) {
      if (!ml.value_name || ml.value_id === '-1') continue
      const kws = TikTokShopService.ML_TO_TT_ATTR[ml.id]
      if (!kws) continue
      const tk = catAttrs.find((t) => kws.some((kw) => this.norm(t.name).includes(this.norm(kw))))
      if (!tk || seen.has(tk.id)) continue
      let value: { id?: string; name: string }
      if (tk.values?.length) {
        const mlv = this.norm(ml.value_name)
        const v =
          tk.values.find((x) => this.norm(x.name) === mlv) ??
          tk.values.find((x) => this.norm(x.name).includes(mlv) || mlv.includes(this.norm(x.name)))
        if (!v) continue // enum sem match → não manda valor inválido
        value = { id: v.id, name: v.name }
      } else {
        value = { name: ml.value_name }
      }
      out.push({ id: tk.id, values: [value] })
      seen.add(tk.id)
    }
    return out
  }

  /** Resolve o brand_id do TikTok a partir do nome da marca (ex.: "Vazzo"). */
  private async resolveTikTokBrandId(
    orgId: string,
    brandName?: string,
  ): Promise<string | null> {
    if (!brandName?.trim()) return null
    try {
      const brands = await this.getBrands(orgId, { keyword: brandName })
      const m = brands.find((b) => this.norm(b.name) === this.norm(brandName))
      return m?.id ?? null
    } catch {
      return null
    }
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

  // ── TT-3: escrita no TikTok (preço + ativar/pausar) ───────────────────────
  // Ações EXPLÍCITAS do usuário (alteram o anúncio AO VIVO). Cada escrita
  // re-sincroniza o produto (syncProductById) pra refletir o estado real.
  // Contrato 202309: prices/update por sku; activate/deactivate por product_id.

  /** Atualiza o preço de UM sku no TikTok (escrita real). */
  async updateSkuPrice(
    orgId: string,
    productId: string,
    skuId: string,
    price: number,
    currency = 'BRL',
  ): Promise<{ ok: true }> {
    if (!(price > 0)) throw new BadRequestException('Preço inválido')
    if (!productId || !skuId) throw new BadRequestException('produto/sku ausente')
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    await this.ttsRequest<unknown>({
      method: 'POST',
      path: `/product/202309/products/${productId}/prices/update`,
      accessToken,
      query: { shop_cipher: shopCipher },
      body: { skus: [{ id: skuId, price: { amount: price.toFixed(2), currency } }] },
    })
    // Reflete o novo estado na tabela local (não-fatal se falhar).
    await this.syncProductById(orgId, productId).catch(() => undefined)
    return { ok: true }
  }

  /** Ativa ou desativa produtos no TikTok (escrita real). */
  async setProductsActive(
    orgId: string,
    productIds: string[],
    active: boolean,
  ): Promise<{ ok: true }> {
    const ids = productIds.filter(Boolean)
    if (ids.length === 0) throw new BadRequestException('Nenhum produto informado')
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    await this.ttsRequest<unknown>({
      method: 'POST',
      path: `/product/202309/products/${active ? 'activate' : 'deactivate'}`,
      accessToken,
      query: { shop_cipher: shopCipher },
      body: { product_ids: ids },
    })
    for (const pid of ids) await this.syncProductById(orgId, pid).catch(() => undefined)
    return { ok: true }
  }

  // ── TT-4: estoque unificado — push do estoque mestre pro TikTok ───────────
  // GATEADO por TIKTOK_STOCK_SYNC=on (default OFF). Quando ligado, o estoque do
  // produto do catálogo (products.stock = espelho do disponível) é empurrado
  // pros SKUs TikTok vinculados — no momento do vínculo e a cada
  // recalcAndPropagate (Icarus, venda ML, edição manual). OFF = nada acontece.

  /** Flag de segurança: só sincroniza estoque pro TikTok quando explicitamente ligado. */
  isStockSyncEnabled(): boolean {
    return process.env.TIKTOK_STOCK_SYNC === 'on'
  }

  /** Atualiza o estoque de UM sku no TikTok (escrita real). */
  async updateSkuInventory(
    orgId: string,
    productId: string,
    skuId: string,
    quantity: number,
    warehouseId: string,
  ): Promise<{ ok: true }> {
    const accessToken = await this.getAccessToken(orgId)
    if (!accessToken) throw new BadRequestException('Loja TikTok Shop não conectada')
    const shopCipher = await this.getShopCipher(orgId)
    await this.ttsRequest<unknown>({
      method: 'POST',
      path: `/product/202309/products/${productId}/inventory/update`,
      accessToken,
      query: { shop_cipher: shopCipher },
      body: {
        skus: [
          { id: skuId, inventory: [{ warehouse_id: warehouseId, quantity: Math.max(0, Math.round(quantity)) }] },
        ],
      },
    })
    return { ok: true }
  }

  /** Empurra o estoque mestre do produto interno pros SKUs TikTok vinculados.
   *  Chamado pelo StockService (recalcAndPropagate) e ao vincular. Gateado.
   *  `qtyOverride` evita reler products.stock quando o recalc já tem o valor.
   *  Lê warehouse_id/tts_product_id do raw importado (sku_id = listing_id). */
  async pushStockForProduct(
    productId: string,
    qtyOverride?: number,
  ): Promise<{ pushed: number; skipped?: string }> {
    if (!this.isStockSyncEnabled()) return { pushed: 0, skipped: 'gate_off' }

    const { data: prod } = await supabaseAdmin
      .from('products')
      .select('organization_id, stock')
      .eq('id', productId)
      .maybeSingle<{ organization_id: string | null; stock: number | null }>()
    const orgId = prod?.organization_id ?? null
    if (!orgId || prod?.stock == null) return { pushed: 0, skipped: 'no_stock_or_org' }
    const qty = Math.max(0, Math.round(qtyOverride ?? prod.stock))

    const { data: vinculos } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id')
      .eq('product_id', productId)
      .eq('platform', 'tiktok_shop')
      .eq('is_active', true)
    if (!vinculos?.length) return { pushed: 0, skipped: 'no_tiktok_links' }

    // mapa sku_id → { ttsProductId, warehouseId } a partir do raw importado
    const { data: rows } = await supabaseAdmin
      .from('tiktok_shop_products')
      .select('tts_product_id, raw')
      .eq('organization_id', orgId)
    const loc = new Map<string, { ttsProductId: string; warehouseId: string | null }>()
    for (const r of (rows ?? []) as Array<{ tts_product_id: string; raw: TtsProduct | null }>) {
      for (const sku of r.raw?.skus ?? []) {
        loc.set(sku.id, {
          ttsProductId: r.tts_product_id,
          warehouseId: sku.inventory?.[0]?.warehouse_id ?? null,
        })
      }
    }

    let pushed = 0
    for (const v of vinculos as Array<{ listing_id: string }>) {
      const where = loc.get(v.listing_id)
      if (!where?.warehouseId) {
        this.logger.warn(`[tts.stock] sku=${v.listing_id} sem warehouse/local — pulado`)
        continue
      }
      try {
        await this.updateSkuInventory(orgId, where.ttsProductId, v.listing_id, qty, where.warehouseId)
        pushed++
        this.logger.log(`[tts.stock] product=${productId} sku=${v.listing_id} → qty=${qty} OK`)
      } catch (e) {
        this.logger.warn(
          `[tts.stock] product=${productId} sku=${v.listing_id} falhou: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
    return { pushed }
  }
}
