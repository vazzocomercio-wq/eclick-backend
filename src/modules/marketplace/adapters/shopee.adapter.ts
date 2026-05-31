import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as crypto from 'crypto'
import {
  MarketplaceAdapter, MarketplacePlatform, MpConnection,
  RawOrder, BuyerBilling, AddressShape, TokenPair,
  WebhookValidationInput, RawListing,
} from './base'
import { ShopThrottleService } from '../throttle/shop-throttle.service'
import { retryWithBackoff } from '../throttle/retry-with-backoff'

const SHOPEE_BASE = 'https://openplatform.shopee.com.br' // BR prod

/** Shopee Open Platform v2 adapter (BR). HMAC-SHA256 hex lowercase em
 * todos os requests. Shop-level sign: partner_id+api_path+timestamp+
 * access_token+shop_id. Auth-level sign (refresh): só partner_id+api_path+
 * timestamp. partner_id/partner_key vem de env (app-level eclick); shop_id
 * + tokens vivem em marketplace_connections. CPF (buyer_cpf_id) vem
 * top-level no detail e é raramente preenchido — fallback para enrichment
 * via phone (recipient_address.phone). Janela máxima do get_order_list é
 * 15 dias; chunkamos em 14d pra dar margem. */
@Injectable()
export class ShopeeAdapter extends MarketplaceAdapter {
  readonly platform: MarketplacePlatform = 'shopee'
  private readonly logger = new Logger(ShopeeAdapter.name)

  constructor(private readonly throttle: ShopThrottleService) {
    super()
  }

  /** F0.6 — wrapper que serializa por shop_id + retry 429/5xx com backoff.
   *  Todo outbound da Shopee passa por aqui. Chave do throttle inclui
   *  prefixo de op pra refresh (sem shop_id válido na config) não colidir
   *  com listOrders da mesma loja. */
  private callShopee<T>(args: {
    key:  string
    tag:  string
    exec: () => Promise<T>
  }): Promise<T> {
    return this.throttle.run(args.key, () =>
      retryWithBackoff(args.exec, { tag: args.tag }),
    )
  }

  // ── sign helpers ────────────────────────────────────────────────────────

  private partnerEnv(): { partnerId: string; partnerKey: string } {
    const partnerId  = process.env.SHOPEE_PARTNER_ID
    const partnerKey = process.env.SHOPEE_PARTNER_KEY
    if (!partnerId)  throw new Error('Env SHOPEE_PARTNER_ID não configurada')
    if (!partnerKey) throw new Error('Env SHOPEE_PARTNER_KEY não configurada')
    return { partnerId, partnerKey }
  }

  /** Shop-level: partner_id + api_path + timestamp + access_token + shop_id */
  private signShop(apiPath: string, ts: number, accessToken: string, shopId: number | string): string {
    const { partnerId, partnerKey } = this.partnerEnv()
    const base = `${partnerId}${apiPath}${ts}${accessToken}${shopId}`
    return crypto.createHmac('sha256', partnerKey).update(base).digest('hex')
  }

  /** Auth-level (refresh_token): partner_id + api_path + timestamp */
  private signAuth(apiPath: string, ts: number): string {
    const { partnerId, partnerKey } = this.partnerEnv()
    const base = `${partnerId}${apiPath}${ts}`
    return crypto.createHmac('sha256', partnerKey).update(base).digest('hex')
  }

  private requireShop(conn: MpConnection): { accessToken: string; shopId: number } {
    if (!conn.access_token) throw new Error('Shopee connection sem access_token')
    if (!conn.shop_id)      throw new Error('Shopee connection sem shop_id')
    return { accessToken: conn.access_token, shopId: conn.shop_id }
  }

  // ── adapter API ─────────────────────────────────────────────────────────

  async listOrders(
    conn:  MpConnection,
    range: { from: Date; to: Date },
  ): Promise<RawOrder[]> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const out: RawOrder[] = []
    const WINDOW_MS = 14 * 86400 * 1000 // 14d (Shopee max 15)

    let chunkFromMs = range.from.getTime()
    const finalToMs = range.to.getTime()

    outer: while (chunkFromMs < finalToMs) {
      const chunkToMs = Math.min(chunkFromMs + WINDOW_MS, finalToMs)
      let cursor = ''
      do {
        const apiPath = '/api/v2/order/get_order_list'
        const ts = Math.floor(Date.now() / 1000)
        const sign = this.signShop(apiPath, ts, accessToken, shopId)
        const qs = new URLSearchParams({
          partner_id:       partnerId,
          timestamp:        String(ts),
          access_token:     accessToken,
          shop_id:          String(shopId),
          sign,
          time_range_field: 'create_time',
          time_from:        String(Math.floor(chunkFromMs / 1000)),
          time_to:          String(Math.floor(chunkToMs   / 1000)),
          page_size:        '100',
          cursor,
        })
        const { data } = await this.callShopee({
          key:  `shop:${shopId}`,
          tag:  'shopee.listOrders',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
        })
        if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
        const orderList: unknown[] = data?.response?.order_list ?? []
        for (const o of orderList) {
          const sn = (o as { order_sn?: string }).order_sn
          if (!sn) continue
          out.push({ external_order_id: String(sn), raw: o })
        }
        cursor = data?.response?.next_cursor ?? ''
        if (!data?.response?.more) break
        if (out.length >= 5000) break outer // safety cap
      } while (cursor)
      chunkFromMs = chunkToMs
    }
    return out
  }

  async getOrderDetail(
    conn:           MpConnection,
    externalOrderId: string,
  ): Promise<RawOrder> {
    const list = await this.fetchDetailBatch(conn, [externalOrderId])
    if (!list.length) throw new Error(`Shopee detail vazio pro order ${externalOrderId}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = list[0] as any
    return {
      external_order_id: String(externalOrderId),
      raw:               r,
      created_at:        r?.create_time ? new Date(r.create_time * 1000).toISOString() : undefined,
      status:            r?.order_status,
    }
  }

  /** Batch detail — Shopee aceita até 50 SNs por call. */
  private async fetchDetailBatch(conn: MpConnection, sns: string[]): Promise<unknown[]> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const BATCH = 50
    const out: unknown[] = []
    for (let i = 0; i < sns.length; i += BATCH) {
      const chunk = sns.slice(i, i + BATCH)
      const apiPath = '/api/v2/order/get_order_detail'
      const ts = Math.floor(Date.now() / 1000)
      const sign = this.signShop(apiPath, ts, accessToken, shopId)
      const qs = new URLSearchParams({
        partner_id:               partnerId,
        timestamp:                String(ts),
        access_token:             accessToken,
        shop_id:                  String(shopId),
        sign,
        order_sn_list:            chunk.join(','),
        response_optional_fields: 'buyer_cpf_id,recipient_address,buyer_user_id,buyer_username,total_amount,pay_time',
      })
      const { data } = await this.callShopee({
        key:  `shop:${shopId}`,
        tag:  'shopee.getOrderDetail',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
      })
      if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
      out.push(...(data?.response?.order_list ?? []))
    }
    return out
  }

  /** CPF top-level (raro). Address inline em recipient_address. Phone é
   * o melhor enrichment fallback quando CPF vier null. */
  async extractBuyerBilling(
    raw:   RawOrder,
    _conn: MpConnection,
  ): Promise<BuyerBilling | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = raw.raw as any
    if (!r) return null

    const cpfRaw  = r.buyer_cpf_id ? String(r.buyer_cpf_id).replace(/\D/g, '') : ''
    const docNum  = cpfRaw || null
    const docType: 'CPF' | 'CNPJ' | null =
      docNum?.length === 14 ? 'CNPJ' :
      docNum?.length === 11 ? 'CPF'  : null

    const recipient = r.recipient_address ?? null
    const phone = recipient?.phone
      ? String(recipient.phone).replace(/\D/g, '') || null
      : null
    const name = recipient?.name ?? r.buyer_username ?? null

    const address: AddressShape | null = recipient ? {
      country_id:    'BR',
      zip_code:      recipient.zipcode      ?? null,
      state:         recipient.state        ?? null,
      city_name:     recipient.city         ?? null,
      neighborhood:  recipient.district     ?? null,
      street_name:   recipient.full_address ?? null, // Shopee não separa logradouro/número
      street_number: null,
      complement:    recipient.region       ?? null,
    } : null

    return {
      doc_type:        docType,
      doc_number:      docNum,
      email:           null, // Shopee não fornece
      phone,
      name,
      last_name:       null,
      billing_info_id: null,
      billing_address: address,
      billing_country: 'BR',
    }
  }

  async refreshToken(conn: MpConnection): Promise<TokenPair> {
    if (!conn.refresh_token) throw new Error('Shopee connection sem refresh_token')
    if (!conn.shop_id)       throw new Error('Shopee connection sem shop_id')
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/auth/access_token/get'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signAuth(apiPath, ts)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId,
      timestamp:  String(ts),
      sign,
    }).toString()
    const body = {
      partner_id:    Number(partnerId),
      shop_id:       conn.shop_id,
      refresh_token: conn.refresh_token,
    }
    const { data } = await this.callShopee({
      key:  `shop:${conn.shop_id}`,
      tag:  'shopee.refreshToken',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    if (data?.error) throw new Error(`Shopee refresh ${data.error}: ${data.message}`)
    // Shopee usa `expire_in` (não `expires_in`)
    const ttlSec = Number(data?.expire_in ?? 14400)
    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + ttlSec * 1000).toISOString(),
    }
  }

  /** F0.7 — Lista anúncios da loja. `get_item_list` (offset/page_size 100,
   *  item_status=NORMAL) devolve só item_ids → `get_item_base_info` (batch 50)
   *  hidrata nome/preço/estoque/imagens. Cursor = offset (string); nextCursor =
   *  next_offset enquanto has_next_page. `image.image_url_list` já são URLs
   *  exibíveis (capa = [0]). `price_info` é ARRAY (item simples = [0]); estoque
   *  = `stock_info_v2.summary_info.total_available_stock`. */
  async listProducts(
    conn:    MpConnection,
    cursor?: string | null,
  ): Promise<{ items: RawListing[]; nextCursor: string | null }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const offset = cursor ? Math.max(0, Number(cursor) || 0) : 0

    // 1) get_item_list — só item_ids + status
    const listPath = '/api/v2/product/get_item_list'
    const ts1   = Math.floor(Date.now() / 1000)
    const sign1 = this.signShop(listPath, ts1, accessToken, shopId)
    const qs1 = new URLSearchParams({
      partner_id:   partnerId,
      timestamp:    String(ts1),
      access_token: accessToken,
      shop_id:      String(shopId),
      sign:         sign1,
      offset:       String(offset),
      page_size:    '100',
      item_status:  'NORMAL',
    })
    const { data: listData } = await this.callShopee({
      key:  `shop:${shopId}`,
      tag:  'shopee.listProducts.list',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${listPath}?${qs1.toString()}`),
    })
    if (listData?.error) throw new Error(`Shopee ${listData.error}: ${listData.message}`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = listData?.response?.item ?? []
    const itemIds = rows
      .map(r => r?.item_id)
      .filter((id): id is number => typeof id === 'number')
    const hasNext    = !!listData?.response?.has_next_page
    const nextOffset = listData?.response?.next_offset

    // 2) get_item_base_info — batch 50 → detalhe
    const items: RawListing[] = []
    const BATCH = 50
    for (let i = 0; i < itemIds.length; i += BATCH) {
      const chunk = itemIds.slice(i, i + BATCH)
      const infoPath = '/api/v2/product/get_item_base_info'
      const ts2   = Math.floor(Date.now() / 1000)
      const sign2 = this.signShop(infoPath, ts2, accessToken, shopId)
      const qs2 = new URLSearchParams({
        partner_id:   partnerId,
        timestamp:    String(ts2),
        access_token: accessToken,
        shop_id:      String(shopId),
        sign:         sign2,
        item_id_list: chunk.join(','),
      })
      const { data: infoData } = await this.callShopee({
        key:  `shop:${shopId}`,
        tag:  'shopee.listProducts.info',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.get<any>(`${SHOPEE_BASE}${infoPath}?${qs2.toString()}`),
      })
      if (infoData?.error) throw new Error(`Shopee ${infoData.error}: ${infoData.message}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: any[] = infoData?.response?.item_list ?? []
      for (const it of list) items.push(this.mapItem(it))
    }

    return {
      items,
      nextCursor: hasNext && nextOffset != null ? String(nextOffset) : null,
    }
  }

  /** Mapeia 1 item do get_item_base_info → RawListing. Guarda o item cru em
   *  `raw` (sync extrai description/image_url_list/create_time/item_sku dali). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapItem(it: any): RawListing {
    const priceArr = Array.isArray(it?.price_info) ? it.price_info : []
    const price = priceArr.length && priceArr[0]?.current_price != null
      ? Number(priceArr[0].current_price)
      : null
    const stockRaw = it?.stock_info_v2?.summary_info?.total_available_stock
    return {
      external_product_id:   String(it?.item_id),
      external_variation_id: null,
      title:                 it?.item_name ?? null,
      price:                 Number.isFinite(price as number) ? price : null,
      stock:                 stockRaw != null ? Number(stockRaw) : null,
      status:                it?.item_status ?? null,
      raw:                   it,
    }
  }

  /** F0.3/F0.5 — webhook Push. Shopee envia header `Authorization` com
   *  HMAC-SHA256(partner_key, `${url}|${body}`) em hex lowercase. Validação
   *  síncrona (sem fetch). rawBody DEVE ser o body cru (não JSON.parsed) —
   *  parse perde whitespace e quebra o hash. URL é a do receptor REGISTRADO
   *  no Shopee Partner Center (não a URL local da request — host/proxy podem
   *  diferir). Caller passa via `input.url`. */
  validateWebhookSignature(input: WebhookValidationInput): boolean {
    const { headers, url, rawBody, secret } = input
    const partnerKey = secret ?? process.env.SHOPEE_PARTNER_KEY
    if (!partnerKey) {
      this.logger.error('[shopee.webhook] SHOPEE_PARTNER_KEY ausente')
      return false
    }
    if (!url) {
      this.logger.warn('[shopee.webhook] url ausente — assinatura Shopee inclui URL')
      return false
    }

    const headerAuth =
      (headers['authorization'] as string | undefined) ??
      (headers['Authorization'] as string | undefined)
    if (!headerAuth) {
      this.logger.warn('[shopee.webhook] header Authorization ausente')
      return false
    }
    const provided = String(headerAuth).trim().toLowerCase()

    const base   = `${url}|${rawBody}`
    const expect = crypto.createHmac('sha256', partnerKey).update(base).digest('hex')

    // timingSafeEqual exige mesmo tamanho — comparar buffers do hex.
    if (provided.length !== expect.length) return false
    try {
      return crypto.timingSafeEqual(
        Buffer.from(provided, 'hex'),
        Buffer.from(expect,   'hex'),
      )
    } catch {
      return false
    }
  }
}
