import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import * as crypto from 'crypto'
import {
  MarketplaceAdapter, MarketplacePlatform, MpConnection,
  RawOrder, BuyerBilling, AddressShape, TokenPair,
  WebhookValidationInput, RawListing, UpdateResult, EscrowDetail,
} from './base'
import { ShopThrottleService } from '../throttle/shop-throttle.service'
import { retryWithBackoff } from '../throttle/retry-with-backoff'

// sharp é CommonJS (export =) — require evita o runtime error "sharp_1.default
// is not a function" (o tsconfig não tem esModuleInterop). Mesmo padrão do
// creative/image-adapter.ts.
const sharp = require('sharp') as typeof import('sharp')

const SHOPEE_BASE = 'https://openplatform.shopee.com.br' // BR prod

/** F1.3 sync — métricas de loja parseadas do módulo account_health.
 *  rating(0-5) e chat NÃO são expostos pela Open Platform v2 → null
 *  (preencher via F12 Chrome Extension no futuro). */
export interface ShopMetricsParsed {
  penalty_points:         number | null
  late_ship_rate:         number | null
  return_refund_rate:     number | null
  prep_time_days:         number | null
  rating:                 number | null
  chat_response_rate:     number | null
  chat_response_time_min: number | null
}

/** Resultado de getShopMetrics — métricas + raw (inspeção) + erros por chamada
 *  (resiliente: falha de permissão num endpoint não derruba o outro). */
export interface ShopMetricsApiResult {
  metrics:         ShopMetricsParsed
  raw_performance: unknown
  raw_penalty:     unknown
  errors:          string[]
}

/** F1.4 sync — 1 campanha (voucher/flash_sale/ads) normalizada pra shopee.campaigns.
 *  voucher/flash_sale NÃO têm spend/GMV (revenue/cost/orders=undefined → 0). SÓ ADS
 *  traz métricas reais (do módulo de performance). status derivado: voucher por
 *  tempo, flash_sale pelo campo `type`, ads pelo status da campanha. */
export interface SyncedCampaignRow {
  kind:           'voucher' | 'flash_sale' | 'ads'
  // valores da CHECK constraint shopee.campaigns: ongoing→active, upcoming→planned, expired→ended
  status:         'active' | 'planned' | 'ended' | 'paused'
  title:          string
  config:         Record<string, unknown>
  starts_at:      string        // ISO
  ends_at:        string | null
  external_id:    string
  raw:            unknown
  // só ADS preenche (spend/GMV/orders). Default 0 no caller pra voucher/flash.
  revenue_cents?: number
  cost_cents?:    number
  orders?:        number
}

export interface CampaignsApiResult {
  campaigns: SyncedCampaignRow[]
  errors:    string[]
}

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
        response_optional_fields: 'item_list,total_amount,actual_shipping_fee,estimated_shipping_fee,payment_method,buyer_cpf_id,recipient_address,buyer_user_id,buyer_username,pay_time',
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

  /** F1.6 — Detalhes crus de N pedidos (batch 50) com item_list + financeiro,
   *  pro ShopeeOrdersIngestionService mapear pra `orders`. Público. */
  async fetchOrderDetails(conn: MpConnection, sns: string[]): Promise<unknown[]> {
    if (!sns.length) return []
    return this.fetchDetailBatch(conn, sns)
  }

  /** Repasse REAL (escrow) de 1 pedido concluído — a fonte da verdade das
   *  taxas Shopee. Devolve o EscrowDetail normalizado (cross-plataforma) E o
   *  order_income cru em `raw` (de onde o ingest lê service_fee/seller_transaction_fee,
   *  que não cabem no shape normalizado). Só funciona em pedidos liquidados. */
  async getEscrowDetail(conn: MpConnection, externalOrderId: string): Promise<EscrowDetail> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/payment/get_escrow_detail'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign, order_sn: externalOrderId,
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`,
      tag: 'shopee.getEscrowDetail',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    const inc = (data?.response?.order_income ?? data?.response ?? {}) as Record<string, unknown>
    return {
      external_order_id: externalOrderId,
      gross_amount:      Number(inc.order_selling_price ?? 0) || null,
      net_amount:        Number(inc.escrow_amount ?? 0) || null,
      commission_amount: Number(inc.commission_fee ?? 0) || null,
      shipping_fee:      Number(inc.actual_shipping_fee ?? 0) || null,
      raw:               inc,
    }
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

  /** F18 Fase A — SKUs do vendedor por item, SEMPRE da API (nunca por título).
   *  Dois lugares na Shopee:
   *   - anúncio COM variação (has_model=true): SKU vive em cada model (`model_sku`),
   *     via get_model_list → [{ model_id, sku }].
   *   - anúncio SEM variação (has_model=false): SKU vive no ITEM (`item_sku`) do
   *     get_item_base_info → [{ model_id: 0, sku }] (item-level, variation '').
   *  Bug antigo lia só model_sku → anúncios sem variação (com item_sku preenchido)
   *  ficavam "sem SKU" e não vinculavam. Agora cobre os dois. Retorna
   *  Map<item_id, [{ model_id, sku }]> pra casar com products.sku no link. */
  async getItemSkus(
    conn:    MpConnection,
    itemIds: number[],
  ): Promise<Map<number, Array<{ model_id: number; sku: string }>>> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const out = new Map<number, Array<{ model_id: number; sku: string }>>()

    // 1) base info em lote (50/call) → item_sku + has_model por item
    const baseInfo = new Map<number, { item_sku: string; has_model: boolean }>()
    const BATCH = 50
    for (let i = 0; i < itemIds.length; i += BATCH) {
      const chunk = itemIds.slice(i, i + BATCH)
      const infoPath = '/api/v2/product/get_item_base_info'
      const ts   = Math.floor(Date.now() / 1000)
      const sign = this.signShop(infoPath, ts, accessToken, shopId)
      const qs = new URLSearchParams({
        partner_id: partnerId, timestamp: String(ts),
        access_token: accessToken, shop_id: String(shopId), sign,
        item_id_list: chunk.join(','),
      })
      try {
        const { data } = await this.callShopee({
          key: `shop:${shopId}`, tag: 'shopee.getItemSkus.base',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${infoPath}?${qs.toString()}`),
        })
        if (data?.error) throw new Error(`${data.error}: ${data.message}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const it of (data?.response?.item_list ?? []) as any[]) {
          baseInfo.set(Number(it?.item_id), {
            item_sku: (it?.item_sku ?? '').toString().trim(),
            has_model: !!it?.has_model,
          })
        }
      } catch (e: unknown) {
        this.logger.warn(`[shopee.getItemSkus] base_info lote falhou: ${(e as Error)?.message}`)
      }
    }

    // 2) por item: model_sku (com variação) OU item_sku (sem variação)
    for (const itemId of itemIds) {
      const base = baseInfo.get(itemId)
      // sem variação → SKU do item
      if (base && !base.has_model) {
        out.set(itemId, base.item_sku ? [{ model_id: 0, sku: base.item_sku }] : [])
        continue
      }
      // com variação (ou desconhecido) → SKU por model
      const path = '/api/v2/product/get_model_list'
      const ts   = Math.floor(Date.now() / 1000)
      const sign = this.signShop(path, ts, accessToken, shopId)
      const qs = new URLSearchParams({
        partner_id: partnerId, timestamp: String(ts),
        access_token: accessToken, shop_id: String(shopId), sign,
        item_id: String(itemId),
      })
      try {
        const { data } = await this.callShopee({
          key:  `shop:${shopId}`, tag: 'shopee.getModelList',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
        })
        if (data?.error) throw new Error(`${data.error}: ${data.message}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const models: any[] = data?.response?.model ?? []
        const pairs: Array<{ model_id: number; sku: string }> = []
        for (const m of models) {
          const sku = (m?.model_sku ?? '').toString().trim()
          if (sku) pairs.push({ model_id: Number(m?.model_id ?? 0), sku })
        }
        // fallback: model sem model_sku mas item tem item_sku → usa item_sku
        if (!pairs.length && base?.item_sku) pairs.push({ model_id: 0, sku: base.item_sku })
        out.set(itemId, pairs)
      } catch (e: unknown) {
        this.logger.warn(`[shopee.getItemSkus] item=${itemId} falhou: ${(e as Error)?.message}`)
        out.set(itemId, base?.item_sku ? [{ model_id: 0, sku: base.item_sku }] : [])
      }
    }
    return out
  }

  /** F18 Fase C — AUDITORIA read-only do estoque de 1 item: devolve o
   *  `stock_info_v2` cru do get_item_base_info + os models do get_model_list
   *  (com stock_info por model). Usado pra CONFIRMAR a estrutura real
   *  (seller_stock vs normal_stock, location_id/multi-armazém, model_id) ANTES
   *  de mapear o update_stock. Loga o raw. Não escreve nada. */
  async inspectItemStock(conn: MpConnection, itemId: number): Promise<{
    item_id:        number
    base_stock_info: unknown
    base_price_info: unknown
    has_model:       boolean
    models:          unknown
  }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()

    // 1) get_item_base_info — stock_info_v2 do item
    const infoPath = '/api/v2/product/get_item_base_info'
    const ts1   = Math.floor(Date.now() / 1000)
    const sign1 = this.signShop(infoPath, ts1, accessToken, shopId)
    const qs1 = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts1),
      access_token: accessToken, shop_id: String(shopId), sign: sign1,
      item_id_list: String(itemId),
    })
    const { data: info } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.inspectStock.base',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${infoPath}?${qs1.toString()}`),
    })
    if (info?.error) throw new Error(`Shopee ${info.error}: ${info.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item0 = (info?.response?.item_list ?? [])[0] as any
    const baseStockInfo = item0?.stock_info_v2 ?? item0?.stock_info ?? null
    const basePriceInfo = item0?.price_info ?? null   // preço nível-item (anúncio sem variação)
    const hasModel = !!item0?.has_model

    // 2) get_model_list — stock por model (variação)
    const mPath = '/api/v2/product/get_model_list'
    const ts2   = Math.floor(Date.now() / 1000)
    const sign2 = this.signShop(mPath, ts2, accessToken, shopId)
    const qs2 = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts2),
      access_token: accessToken, shop_id: String(shopId), sign: sign2,
      item_id: String(itemId),
    })
    const { data: models } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.inspectStock.models',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${mPath}?${qs2.toString()}`),
    })
    if (models?.error) throw new Error(`Shopee ${models.error}: ${models.message}`)

    this.logger.log(`[shopee.inspectStock] item=${itemId} base_stock_info=${JSON.stringify(baseStockInfo)} models=${JSON.stringify(models?.response ?? null)}`)
    return { item_id: itemId, base_stock_info: baseStockInfo, base_price_info: basePriceInfo, has_model: hasModel, models: models?.response ?? null }
  }

  /** Sync de confirmação — status atual de 1 item (get_item_base_info →
   *  item_status). A esteira IA Criativo usa pra confirmar que o anúncio
   *  continua no ar. Retorna o item_status cru da Shopee
   *  (NORMAL/UNLIST/BANNED/DELETED/REVIEWING/SELLER_DELETE…) ou null. */
  async getItemStatus(conn: MpConnection, itemId: number | string): Promise<string | null> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const infoPath = '/api/v2/product/get_item_base_info'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(infoPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      item_id_list: String(itemId),
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.getItemStatus',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${infoPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = (data?.response?.item_list ?? [])[0] as any
    return (item?.item_status as string | undefined) ?? null
  }

  /** F18 Fase C — Resolve o `location_id` do seller_stock da loja a partir de 1
   *  item (read-only, via get_model_list). Sellers BR têm armazém nomeado (ex
   *  "BRZ") — o update_stock precisa do MESMO location_id, senão a escrita não
   *  bate no armazém certo. Devolve o 1º location_id encontrado (uniforme por
   *  loja) ou null (omitir → armazém default). */
  async resolveSellerLocationId(conn: MpConnection, itemId: number): Promise<string | null> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/product/get_model_list'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      item_id: String(itemId),
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.resolveLocation',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const models: any[] = data?.response?.model ?? []
    for (const m of models) {
      const seller = m?.stock_info_v2?.seller_stock
      if (Array.isArray(seller)) {
        for (const s of seller) {
          if (s?.location_id) return String(s.location_id)
        }
      }
    }
    return null
  }

  /** F18 Fase C/D — Atualiza o estoque de 1 anúncio/variação Shopee.
   *  `POST /api/v2/product/update_stock` (sign shop-level). Estrutura v2:
   *  `stock_list: [{ model_id, seller_stock: [{ location_id?, stock }] }]`.
   *  model_id=0 quando o item não tem variação (variation_id ''). location_id
   *  (ex "BRZ") DEVE bater com o armazém do seller — auditado via
   *  resolveSellerLocationId; omitido = armazém default. ⚠️ ESCREVE estoque
   *  REAL na loja. Loga o raw + trata failure_list (200 mas falha por model). */
  async updateStock(
    conn: MpConnection,
    args: {
      externalProductId:    string
      externalVariationId?: string | null
      quantity:             number
      locationId?:          string | null
    },
  ): Promise<UpdateResult> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const itemId  = Number(args.externalProductId)
    const modelId = args.externalVariationId ? Number(args.externalVariationId) : 0
    const stock   = Math.max(0, Math.round(Number(args.quantity) || 0))

    const apiPath = '/api/v2/product/update_stock'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const sellerStock = args.locationId
      ? [{ location_id: args.locationId, stock }]
      : [{ stock }]
    const body = {
      item_id: itemId,
      stock_list: [
        { model_id: modelId, seller_stock: sellerStock },
      ],
    }

    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.updateStock',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    this.logger.log(`[shopee.updateStock] item=${itemId} model=${modelId} stock=${stock} → ${JSON.stringify(data)}`)

    // O failure_list vem MESMO quando há erro top-level (ex: error_busi_update_stock_failed
    // com message genérica) — extrair o failed_reason antes, senão o motivo real se perde.
    const failures = data?.response?.failure_list ?? data?.response?.failed_list ?? []
    if (Array.isArray(failures) && failures.length) {
      const f0 = failures[0]
      const reason = f0?.failed_reason ?? f0?.reason ?? data?.message ?? 'desconhecido'
      const err = new Error(`Shopee update_stock falhou model=${f0?.model_id}: ${reason}`) as Error & { reserveStock?: number }
      // "Stock should be larger than 125 (reserve stock number)" = item em campanha
      // (flash sale/promoção) com estoque reservado — Shopee não aceita valor abaixo.
      const m = /larger than (\d+)\s*\(reserve stock/i.exec(String(reason))
      if (m) err.reserveStock = Number(m[1])
      throw err
    }
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)

    return {
      ok: true,
      external_product_id:   String(itemId),
      external_variation_id: modelId ? String(modelId) : null,
      raw: data,
    }
  }

  /** F18 Fase D — Atualiza o PREÇO de 1 anúncio/variação Shopee.
   *  `POST /api/v2/product/update_price` (sign shop-level). Estrutura v2:
   *  `price_list: [{ model_id, original_price }]`. O preço setado é o
   *  ORIGINAL (preço de lista); promoções/flash da Shopee aplicam desconto
   *  POR CIMA dele (current_price = original − desconto). model_id=0 quando o
   *  item não tem variação. ⚠️ ESCREVE PREÇO REAL ($) na loja. Loga o raw +
   *  trata failure_list (200 mas falha por model). */
  async updatePrice(
    conn: MpConnection,
    args: {
      externalProductId:    string
      externalVariationId?: string | null
      price:                number
    },
  ): Promise<UpdateResult> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const itemId  = Number(args.externalProductId)
    const modelId = args.externalVariationId ? Number(args.externalVariationId) : 0
    const price   = Number(args.price)
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Shopee update_price: preço inválido (${args.price})`)
    }

    const apiPath = '/api/v2/product/update_price'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const body = {
      item_id: itemId,
      price_list: [
        { model_id: modelId, original_price: price },
      ],
    }

    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.updatePrice',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    this.logger.log(`[shopee.updatePrice] item=${itemId} model=${modelId} price=${price} → ${JSON.stringify(data)}`)
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)

    const failures = data?.response?.failure_list ?? data?.response?.failed_list ?? []
    if (Array.isArray(failures) && failures.length) {
      const f0 = failures[0]
      throw new Error(`Shopee update_price falhou model=${f0?.model_id}: ${f0?.failed_reason ?? f0?.reason ?? 'desconhecido'}`)
    }

    return {
      ok: true,
      external_product_id:   String(itemId),
      external_variation_id: modelId ? String(modelId) : null,
      raw: data,
    }
  }

  /** F18 Fase E — Detalhe editável de 1 item (read). get_item_base_info com
   *  description/attribute (response_optional_fields). Devolve título,
   *  descrição + `description_type` (CRÍTICO: 'normal' = texto editável via
   *  update_item.description; 'extended'/rich = NÃO editável por esse campo),
   *  category_id e attribute_list cru. Loga p/ auditoria. */
  async getItemForEdit(conn: MpConnection, itemId: number): Promise<{
    item_id:          number
    item_name:        string | null
    description:      string | null
    description_type: string | null
    category_id:      number | null
    attribute_list:   unknown
    raw:              unknown
  }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/product/get_item_base_info'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      item_id_list: String(itemId),
      need_tax_info: 'false', need_complaint_policy: 'false',
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.getItemForEdit',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const it = (data?.response?.item_list ?? [])[0] as any
    const descType = it?.description_type ?? null
    this.logger.log(`[shopee.getItemForEdit] item=${itemId} name="${it?.item_name}" desc_type=${descType} cat=${it?.category_id} attrs=${Array.isArray(it?.attribute_list) ? it.attribute_list.length : 0}`)
    return {
      item_id:          itemId,
      item_name:        it?.item_name ?? null,
      description:      typeof it?.description === 'string' ? it.description : null,
      description_type: descType,
      category_id:      it?.category_id != null ? Number(it.category_id) : null,
      attribute_list:   it?.attribute_list ?? null,
      raw:              it ?? null,
    }
  }

  /** F18 Fase E — Edição completa do item (título/descrição/atributos).
   *  `POST /api/v2/product/update_item`. Só envia os campos fornecidos (partial
   *  update). ⚠️ description SÓ funciona em item description_type='normal'
   *  (texto puro) — em 'extended' (rich) a Shopee rejeita; o caller checa via
   *  getItemForEdit antes. attribute_list é pass-through (shape da Shopee:
   *  [{ attribute_id, attribute_value_list:[{value_id, original_value_name}] }]).
   *  Loga o raw. ⚠️ ESCREVE conteúdo REAL na loja. */
  async updateItem(
    conn: MpConnection,
    args: {
      externalProductId: string
      itemName?:         string | null
      description?:      string | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attributeList?:    any[] | null
    },
  ): Promise<UpdateResult> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const itemId = Number(args.externalProductId)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = { item_id: itemId }
    if (args.itemName != null && args.itemName.trim() !== '') body.item_name = args.itemName.trim()
    if (args.description != null) body.description = args.description
    if (Array.isArray(args.attributeList) && args.attributeList.length) body.attribute_list = args.attributeList
    if (Object.keys(body).length <= 1) throw new Error('updateItem: nada para atualizar')

    const apiPath = '/api/v2/product/update_item'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()

    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.updateItem',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    this.logger.log(`[shopee.updateItem] item=${itemId} fields=${Object.keys(body).filter(k => k !== 'item_id').join(',')} → ${JSON.stringify(data)?.slice(0, 400)}`)
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)

    return { ok: true, external_product_id: String(itemId), raw: data }
  }

  // ── F18 Fase F — Publicar novo anúncio (esteira IA Criativo → add_item) ─────

  /** Sobe 1 imagem (por URL) pro media space da Shopee e devolve o image_id.
   *  `POST /api/v2/media_space/upload_image` (multipart, campo `image`).
   *  add_item exige image_id (NÃO URL). scene='normal' (capa/galeria). */
  async uploadImage(conn: MpConnection, imageUrl: string): Promise<string> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/media_space/upload_image'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()

    // baixa a imagem e CONVERTE pra JPEG. O media_space da Shopee aceita
    // JPG/PNG mas NÃO WEBP — as imagens do IA Criativo são WEBP, então sem
    // converter a Shopee devolve error_param "image is invalid or not supported".
    // sharp normaliza qualquer formato (webp/png/jpg) → JPEG com content-type certo.
    const imgResp = await axios.get<ArrayBuffer>(imageUrl, { responseType: 'arraybuffer' })
    let jpeg: Buffer
    try {
      jpeg = await sharp(Buffer.from(imgResp.data))
        .rotate() // respeita orientação EXIF
        .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer()
    } catch (e) {
      throw new Error(`Shopee uploadImage: falha ao converter imagem pra JPEG (${(e as Error)?.message})`)
    }
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'image.jpg')
    form.append('scene', 'normal')

    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.uploadImage',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, form),
    })
    if (data?.error) throw new Error(`Shopee uploadImage ${data.error}: ${data.message}`)
    const imageId = data?.response?.image_info?.image_id
      ?? data?.response?.image_info_list?.[0]?.image_info?.image_id
    if (!imageId) throw new Error(`Shopee uploadImage sem image_id: ${JSON.stringify(data)?.slice(0, 200)}`)
    return String(imageId)
  }

  /** Recomenda category_id da Shopee a partir do nome do produto.
   *  `GET /api/v2/product/category_recommend`. add_item exige category_id. */
  async recommendCategory(conn: MpConnection, itemName: string): Promise<number | null> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/product/category_recommend'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      item_name: itemName.slice(0, 120),
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.categoryRecommend',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee categoryRecommend ${data.error}: ${data.message}`)
    const ids: unknown[] = data?.response?.category_id ?? []
    const first = ids.find(x => Number.isFinite(Number(x)))
    return first != null ? Number(first) : null
  }

  /** Atributos (obrigatórios/opcionais) de uma categoria.
   *  `GET /api/v2/product/get_attribute_tree` (language pt-br). ⚠️ o antigo
   *  `get_attributes` foi DEPRECADO/removido (dava HTTP 403 "request path is
   *  incorrect"); o atual é get_attribute_tree. add_item precisa preencher os
   *  mandatórios. Devolve o raw pro caller montar attribute_list. */
  async getCategoryAttributes(conn: MpConnection, categoryId: number): Promise<unknown> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/product/get_attribute_tree'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      // ⚠️ o param é category_id_LIST (não category_id singular) — com o nome
      // errado a Shopee IGNORA e devolve response:{} vazio. Confirmado ao vivo.
      category_id_list: String(categoryId), language: 'pt-br',
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.getAttributeTree',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee getAttributeTree ${data.error}: ${data.message}`)
    return data?.response ?? null
  }

  /** Canais de logística habilitados da loja. `GET /api/v2/logistics/get_channel_list`.
   *  add_item exige logistic_info com os channel_id habilitados. */
  async getLogisticsChannels(conn: MpConnection): Promise<Array<{ channel_id: number; enabled: boolean; name: string }>> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/logistics/get_channel_list'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.logisticsChannels',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee getChannelList ${data.error}: ${data.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (data?.response?.logistics_channel_list ?? []) as any[]
    return list.map(c => ({
      channel_id: Number(c?.logistics_channel_id ?? c?.channel_id),
      enabled:    !!c?.enabled,
      name:       c?.logistics_channel_name ?? '',
    }))
  }

  /** Cria um novo anúncio. `POST /api/v2/product/add_item`. Body montado pelo
   *  caller (publish service) com category_id, imagens (image_id), preço,
   *  estoque, peso, dimensão, logística e atributos. ⚠️ CRIA listing REAL
   *  (entra em review da Shopee). Loga raw + devolve item_id. */
  async addItem(
    conn: MpConnection,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: Record<string, any>,
  ): Promise<{ item_id: number; raw: unknown }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/add_item'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()

    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.addItem',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, payload),
    })
    this.logger.log(`[shopee.addItem] → ${JSON.stringify(data)?.slice(0, 500)}`)
    if (data?.error) throw new Error(`Shopee addItem ${data.error}: ${data.message}`)
    const itemId = data?.response?.item_id
    if (!itemId) throw new Error(`Shopee addItem sem item_id: ${JSON.stringify(data)?.slice(0, 200)}`)
    return { item_id: Number(itemId), raw: data }
  }

  /** F18 Fase F — Remove um anúncio (rollback do teste de publish). */
  /** Multiplicador — inicializa VARIAÇÕES (tier_variation + models) num item
   *  recém-criado. `POST /api/v2/product/init_tier_variation`. 1 dimensão
   *  (ex.: Cor) com N opções; cada model nasce com estoque 0 (o motor central
   *  empurra depois, por model). Retorna os models criados (model_id +
   *  tier_index) — se a resposta não trouxer, lê via get_model_list. */
  async initTierVariation(conn: MpConnection, args: {
    itemId:   number
    tierName: string
    options:  string[]
    models:   Array<{ tierIndex: number; price: number; sku?: string | null }>
  }): Promise<Array<{ model_id: number; tier_index: number[] }>> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/init_tier_variation'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()

    const payload = {
      item_id: args.itemId,
      tier_variation: [{
        name: args.tierName.slice(0, 14), // limite Shopee pro nome da dimensão
        option_list: args.options.map(o => ({ option: o.slice(0, 30) })),
      }],
      model: args.models.map(m => ({
        tier_index:     [m.tierIndex],
        original_price: m.price,
        seller_stock:   [{ stock: 0 }],
        ...(m.sku ? { model_sku: m.sku } : {}),
      })),
    }

    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.initTierVariation',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, payload),
    })
    this.logger.log(`[shopee.initTierVariation] item=${args.itemId} → ${JSON.stringify(data)?.slice(0, 400)}`)
    if (data?.error) throw new Error(`Shopee init_tier_variation ${data.error}: ${data.message}`)

    const fromResp = (data?.response?.model ?? []) as Array<{ model_id?: number; tier_index?: number[] }>
    const models = fromResp
      .filter(m => m?.model_id != null)
      .map(m => ({ model_id: Number(m.model_id), tier_index: m.tier_index ?? [] }))
    if (models.length > 0) return models

    // fallback: a resposta nem sempre ecoa os models — lê via get_model_list
    return this.getModelListRaw(conn, args.itemId)
  }

  /** get_model_list cru (model_id + tier_index) — suporte do initTierVariation. */
  private async getModelListRaw(conn: MpConnection, itemId: number): Promise<Array<{ model_id: number; tier_index: number[] }>> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/get_model_list'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      item_id: String(itemId),
    }).toString()
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.getModelListRaw',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(url),
    })
    if (data?.error) throw new Error(`Shopee get_model_list ${data.error}: ${data.message}`)
    return ((data?.response?.model ?? []) as Array<{ model_id?: number; tier_index?: number[] }>)
      .filter(m => m?.model_id != null)
      .map(m => ({ model_id: Number(m.model_id), tier_index: m.tier_index ?? [] }))
  }

  /** F18 Fase F — Remove um anúncio (rollback do teste de publish). */
  async deleteItem(conn: MpConnection, itemId: number): Promise<void> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/delete_item'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.deleteItem',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, { item_id: itemId }),
    })
    if (data?.error) throw new Error(`Shopee deleteItem ${data.error}: ${data.message}`)
  }

  // ── F18 Marketing inteligente — probe de escopo do módulo Flash Sale ────────
  /** Lê os time slots de Oferta Relâmpago da loja (próximos dias). Serve de
   *  PROBE de escopo do módulo shop_flash_sale: se devolver 403, o app não tem
   *  permissão de gestão de promoções (igual ao bloqueio do Ads). Read-only. */
  async getFlashSaleTimeSlots(conn: MpConnection): Promise<{ ok: boolean; slots: unknown[]; error?: string }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/shop_flash_sale/get_shop_flash_sale_time_slot_id'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const startTime = ts
    const endTime   = ts + 7 * 86400
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
      start_time: String(startTime), end_time: String(endTime),
    })
    try {
      const { data } = await this.callShopee({
        key: `shop:${shopId}`, tag: 'shopee.flashTimeSlots',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs.toString()}`),
      })
      if (data?.error) return { ok: false, slots: [], error: `${data.error}: ${data.message}` }
      return { ok: true, slots: data?.response ?? [] }
    } catch (e: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status = (e as any)?.response?.status
      return { ok: false, slots: [], error: status === 403 ? '403 Forbidden' : ((e as Error)?.message ?? 'erro') }
    }
  }

  /** F18 Marketing — cria um Desconto (promoção) e devolve discount_id.
   *  `POST /api/v2/discount/add_discount`. Datas Unix (s). ⚠️ cria promo REAL. */
  async addDiscount(conn: MpConnection, args: { name: string; startTime: number; endTime: number }): Promise<{ discount_id: number; raw: unknown }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/discount/add_discount'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const body = { discount_name: args.name.slice(0, 25), start_time: args.startTime, end_time: args.endTime }
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.addDiscount',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    this.logger.log(`[shopee.addDiscount] → ${JSON.stringify(data)?.slice(0, 300)}`)
    if (data?.error) throw new Error(`Shopee addDiscount ${data.error}: ${data.message}`)
    const id = data?.response?.discount_id
    if (!id) throw new Error(`Shopee addDiscount sem discount_id: ${JSON.stringify(data)?.slice(0, 200)}`)
    return { discount_id: Number(id), raw: data }
  }

  /** Adiciona itens/variações a um Desconto. `POST /api/v2/discount/add_discount_item`.
   *  model_promotion_price = preço promocional por model. ⚠️ promo REAL. */
  async addDiscountItems(conn: MpConnection, args: {
    discountId: number
    itemId:     number
    models:     Array<{ model_id: number; promotion_price: number }>
  }): Promise<{ raw: unknown }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/discount/add_discount_item'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const model_list = args.models.filter(m => m.model_id > 0).map(m => ({ model_id: m.model_id, model_promotion_price: m.promotion_price }))
    const item: Record<string, unknown> = { item_id: args.itemId }
    if (model_list.length) item.model_list = model_list
    else item.item_promotion_price = args.models[0]?.promotion_price
    const body = { discount_id: args.discountId, item_list: [item] }
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.addDiscountItem',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    this.logger.log(`[shopee.addDiscountItems] discount=${args.discountId} item=${args.itemId} → ${JSON.stringify(data)?.slice(0, 300)}`)
    if (data?.error) throw new Error(`Shopee addDiscountItem ${data.error}: ${data.message}`)
    const fail = data?.response?.error_list ?? data?.response?.fail_list ?? []
    if (Array.isArray(fail) && fail.length) throw new Error(`Shopee addDiscountItem falha: ${JSON.stringify(fail[0])?.slice(0, 150)}`)
    return { raw: data }
  }

  /** Remove um Desconto (rollback do teste). `POST /api/v2/discount/delete_discount`. */
  async deleteDiscount(conn: MpConnection, discountId: number): Promise<void> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/discount/delete_discount'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.deleteDiscount',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, { discount_id: discountId }),
    })
    if (data?.error) throw new Error(`Shopee deleteDiscount ${data.error}: ${data.message}`)
  }

  /** F1.3 — Snapshot de métricas da loja (módulo account_health).
   *  - get_shop_performance → metric_list: id 1/85 = late_ship_rate, 43/92 =
   *    return_refund_rate, 4 = prep_time_days. unit % normalizado p/ 0-1.
   *  - get_shop_penalty → penalty_points.overall_penalty_points (fallback path
   *    `shop_penalty` se o 1º der error_param).
   *  rating(0-5)/chat = null (NÃO expostos na v2 — F12 Chrome Ext no futuro).
   *  Resiliente: erro num endpoint (ex: módulo não autorizado) vai pra errors[]
   *  sem derrubar o outro. Retorna raw p/ inspeção dos metric_id/units reais. */
  async getShopMetrics(conn: MpConnection): Promise<ShopMetricsApiResult> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const errors: string[] = []
    const metrics: ShopMetricsParsed = {
      penalty_points: null, late_ship_rate: null, return_refund_rate: null,
      prep_time_days: null, rating: null, chat_response_rate: null,
      chat_response_time_min: null,
    }
    let rawPerformance: unknown = null
    let rawPenalty: unknown = null

    const buildQs = (path: string): string => {
      const ts = Math.floor(Date.now() / 1000)
      const sign = this.signShop(path, ts, accessToken, shopId)
      return new URLSearchParams({
        partner_id: partnerId, timestamp: String(ts),
        access_token: accessToken, shop_id: String(shopId), sign,
      }).toString()
    }
    // % → fração 0-1: a API pode mandar 0.012 (fração) ou 1.2 (percentual).
    const toRate = (v: unknown): number | null => {
      const n = Number(v)
      if (!Number.isFinite(n)) return null
      return n > 1 ? n / 100 : n
    }

    // 1) get_shop_performance
    try {
      const path = '/api/v2/account_health/get_shop_performance'
      const { data } = await this.callShopee({
        key: `shop:${shopId}`, tag: 'shopee.shopPerformance',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${buildQs(path)}`),
      })
      if (data?.error) throw new Error(`${data.error}: ${data.message}`)
      rawPerformance = data?.response ?? null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: any[] = data?.response?.metric_list ?? []
      // metric_ids confirmados no ar (loja Vazzo, get_shop_performance):
      //  1=late_shipment_rate(%), 43=return_refund_rate(%), 2033/4=avg_prep_time(dia),
      //  11=response_rate chat(%), 22=shop_rating(0-5). unit % → fração via toRate.
      for (const m of list) {
        const id = m?.metric_id
        const v  = m?.current_period
        if (v == null) continue
        if (id === 1 || id === 85)         metrics.late_ship_rate     = toRate(v)
        else if (id === 43 || id === 92)   metrics.return_refund_rate = toRate(v)
        else if (id === 2033 || id === 4)  metrics.prep_time_days     = Number(v)
        else if (id === 11)                metrics.chat_response_rate = toRate(v)
        else if (id === 22)                metrics.rating             = Number(v)
      }
    } catch (e: unknown) {
      errors.push(`performance: ${(e as Error)?.message}`)
    }

    // 2) get_shop_penalty (fallback path `shop_penalty`)
    for (const path of [
      '/api/v2/account_health/get_shop_penalty',
      '/api/v2/account_health/shop_penalty',
    ]) {
      try {
        const { data } = await this.callShopee({
          key: `shop:${shopId}`, tag: 'shopee.shopPenalty',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${buildQs(path)}`),
        })
        if (data?.error) throw new Error(`${data.error}: ${data.message}`)
        rawPenalty = data?.response ?? null
        const pp = data?.response?.penalty_points?.overall_penalty_points
        if (pp != null) metrics.penalty_points = Number(pp)
        break // sucesso → não tenta o fallback
      } catch (e: unknown) {
        if (path.endsWith('shop_penalty')) errors.push(`penalty: ${(e as Error)?.message}`)
      }
    }

    return { metrics, raw_performance: rawPerformance, raw_penalty: rawPenalty, errors }
  }

  /** F1.4 — Campanhas reais da loja: vouchers (get_voucher_list ongoing+upcoming
   *  → get_voucher por id, pois o list é magro) + flash sales (get_shop_flash_sale_list
   *  type 1/2; o list já traz tudo). Datas Unix s. status do voucher = derivado do
   *  tempo; do flash_sale = campo `type` (1 upcoming/2 ongoing/3 expired). Sem
   *  spend/GMV (só módulo Ads). Resiliente: error_permission num tipo → errors[]
   *  sem derrubar o outro. */
  async getCampaigns(conn: MpConnection): Promise<CampaignsApiResult> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const errors: string[] = []
    const campaigns: SyncedCampaignRow[] = []
    const nowSec = Math.floor(Date.now() / 1000)

    const qs = (path: string, extra: Record<string, string>): string => {
      const ts = Math.floor(Date.now() / 1000)
      const sign = this.signShop(path, ts, accessToken, shopId)
      return new URLSearchParams({
        partner_id: partnerId, timestamp: String(ts),
        access_token: accessToken, shop_id: String(shopId), sign, ...extra,
      }).toString()
    }
    const toIso = (sec: unknown): string | null => {
      const n = Number(sec)
      return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
    }
    const nowIso = new Date().toISOString()

    // ── VOUCHERS (ongoing + upcoming) ──────────────────────────────────────
    try {
      const ids = new Set<number>()
      for (const status of ['ongoing', 'upcoming']) {
        let page = 1
        for (;;) {
          const path = '/api/v2/voucher/get_voucher_list'
          const { data } = await this.callShopee({
            key: `shop:${shopId}`, tag: 'shopee.voucherList',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs(path, { status, page_no: String(page), page_size: '100' })}`),
          })
          if (data?.error) throw new Error(`${data.error}: ${data.message}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const v of (data?.response?.voucher_list ?? []) as any[]) {
            if (v?.voucher_id != null) ids.add(Number(v.voucher_id))
          }
          if (!data?.response?.more || page >= 50) break
          page++
        }
      }
      for (const vid of ids) {
        const path = '/api/v2/voucher/get_voucher'
        const { data } = await this.callShopee({
          key: `shop:${shopId}`, tag: 'shopee.voucherGet',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs(path, { voucher_id: String(vid) })}`),
        })
        if (data?.error) { errors.push(`voucher ${vid}: ${data.error}`); continue }
        const v = data?.response
        if (!v) continue
        const start = Number(v.start_time)
        const end   = Number(v.end_time)
        const status: SyncedCampaignRow['status'] =
          start && nowSec < start ? 'planned' : end && nowSec > end ? 'ended' : 'active'
        campaigns.push({
          kind: 'voucher', status,
          title: v.voucher_name ?? `Voucher ${vid}`,
          config: {
            voucher_code: v.voucher_code ?? null, voucher_type: v.voucher_type ?? null,
            reward_type: v.reward_type ?? null, discount_amount: v.discount_amount ?? null,
            percentage: v.percentage ?? null, max_price: v.max_price ?? null,
            min_basket_price: v.min_basket_price ?? null,
            usage_quantity: v.usage_quantity ?? null, current_usage: v.current_usage ?? null,
          },
          starts_at: toIso(start) ?? nowIso, ends_at: toIso(end),
          external_id: String(vid), raw: v,
        })
      }
    } catch (e: unknown) {
      errors.push(`vouchers: ${(e as Error)?.message}`)
    }

    // ── FLASH SALES (upcoming + ongoing) ────────────────────────────────────
    try {
      for (const type of [1, 2]) { // 1=upcoming, 2=ongoing
        let offset = 0
        for (;;) {
          const path = '/api/v2/shop_flash_sale/get_shop_flash_sale_list'
          const { data } = await this.callShopee({
            key: `shop:${shopId}`, tag: 'shopee.flashList',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs(path, { type: String(type), offset: String(offset), limit: '100' })}`),
          })
          if (data?.error) throw new Error(`${data.error}: ${data.message}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const list = (data?.response?.flash_sale_list ?? []) as any[]
          const total = Number(data?.response?.total_count ?? 0)
          for (const f of list) {
            if (Number(f?.status) === 0) continue // deleted
            const start = Number(f.start_time)
            const end   = Number(f.end_time)
            const t = Number(f.type)
            const status: SyncedCampaignRow['status'] =
              t === 1 ? 'planned' : t === 3 ? 'ended' : 'active'
            campaigns.push({
              kind: 'flash_sale', status,
              title: `Flash Sale ${toIso(start)?.slice(0, 10) ?? f.flash_sale_id}`,
              config: {
                timeslot_id: f.timeslot_id ?? null, item_count: f.item_count ?? null,
                enabled_item_count: f.enabled_item_count ?? null,
                click_count: f.click_count ?? null, remindme_count: f.remindme_count ?? null,
                fs_status: f.status ?? null, fs_type: f.type ?? null,
              },
              starts_at: toIso(start) ?? nowIso, ends_at: toIso(end),
              external_id: String(f.flash_sale_id), raw: f,
            })
          }
          offset += list.length
          if (list.length === 0 || offset >= total || offset > 5000) break
        }
      }
    } catch (e: unknown) {
      errors.push(`flash_sales: ${(e as Error)?.message}`)
    }

    // ── ADS (módulo 105 — ESCOPO SEPARADO, pode dar error_auth/permission) ──
    // Único com spend/GMV/orders reais. Probe get_total_balance primeiro pra
    // não varrer se o escopo não estiver autorizado (precisa re-OAuth se foi
    // habilitado depois de conectar). Dinheiro = float BRL → *100 = centavos.
    try {
      // probe de permissão
      const balPath = '/api/v2/ads/get_total_balance'
      const { data: bal } = await this.callShopee({
        key: `shop:${shopId}`, tag: 'shopee.adsBalance',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.get<any>(`${SHOPEE_BASE}${balPath}?${qs(balPath, {})}`),
      })
      if (bal?.error) throw new Error(`${bal.error}: ${bal.message}`)

      // 1) índice de campanhas (paginação has_next_page)
      const adList: Array<{ id: number; ad_type: string }> = []
      let offset = 0
      for (;;) {
        const path = '/api/v2/ads/get_product_level_campaign_id_list'
        const { data } = await this.callShopee({
          key: `shop:${shopId}`, tag: 'shopee.adsIdList',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${path}?${qs(path, { ad_type: 'all', offset: String(offset), limit: '1000' })}`),
        })
        if (data?.error) throw new Error(`${data.error}: ${data.message}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list = (data?.response?.campaign_list ?? []) as any[]
        for (const c of list) if (c?.campaign_id != null) adList.push({ id: Number(c.campaign_id), ad_type: String(c.ad_type ?? '') })
        if (!data?.response?.has_next_page || list.length === 0) break
        offset += list.length
        if (offset > 10000) break
      }

      if (adList.length) {
        // janela de performance: últimos 30 dias, formato DD-MM-YYYY (≤31d)
        const pad = (n: number) => String(n).padStart(2, '0')
        const ddmmyyyy = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`
        const endD = new Date()
        const startD = new Date(Date.now() - 30 * 86400 * 1000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const settingById = new Map<number, any>()
        const perfById = new Map<number, { spend: number; gmv: number; orders: number; impr: number; clk: number; name?: string }>()

        const ids = adList.map(a => a.id)
        for (let i = 0; i < ids.length; i += 100) {
          const chunk = ids.slice(i, i + 100).join(',')
          // settings (info_type 1 = common_info)
          const sPath = '/api/v2/ads/get_product_level_campaign_setting_info'
          const { data: sData } = await this.callShopee({
            key: `shop:${shopId}`, tag: 'shopee.adsSetting',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            exec: () => axios.get<any>(`${SHOPEE_BASE}${sPath}?${qs(sPath, { info_type_list: '1', campaign_id_list: chunk })}`),
          })
          if (sData?.error) throw new Error(`${sData.error}: ${sData.message}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const c of (sData?.response?.campaign_list ?? []) as any[]) {
            if (c?.campaign_id != null) settingById.set(Number(c.campaign_id), c.common_info ?? {})
          }
          // performance diária (agregada na janela)
          const pPath = '/api/v2/ads/get_product_campaign_daily_performance'
          const { data: pData } = await this.callShopee({
            key: `shop:${shopId}`, tag: 'shopee.adsPerf',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            exec: () => axios.get<any>(`${SHOPEE_BASE}${pPath}?${qs(pPath, { start_date: ddmmyyyy(startD), end_date: ddmmyyyy(endD), campaign_id_list: chunk })}`),
          })
          if (pData?.error) throw new Error(`${pData.error}: ${pData.message}`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const sh of (pData?.response ?? []) as any[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const c of (sh?.campaign_list ?? []) as any[]) {
              let spend = 0, gmv = 0, orders = 0, impr = 0, clk = 0
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const m of (c?.metrics_list ?? []) as any[]) {
                spend += Number(m.expense) || 0
                gmv   += Number(m.broad_gmv) || 0
                orders += Number(m.broad_order) || 0
                impr  += Number(m.impression) || 0
                clk   += Number(m.clicks) || 0
              }
              perfById.set(Number(c.campaign_id), { spend, gmv, orders, impr, clk, name: c?.ad_name })
            }
          }
        }

        for (const { id, ad_type } of adList) {
          const ci = settingById.get(id) ?? {}
          const perf = perfById.get(id) ?? { spend: 0, gmv: 0, orders: 0, impr: 0, clk: 0 }
          const cs = String(ci.campaign_status ?? '')
          const status: SyncedCampaignRow['status'] =
            cs === 'scheduled' ? 'planned'
              : cs === 'paused' ? 'paused'
                : (cs === 'ended' || cs === 'closed' || cs === 'deleted') ? 'ended'
                  : 'active'
          const dur = ci.campaign_duration ?? {}
          const startSec = Number(dur.start_time)
          const endSec   = Number(dur.end_time)
          const roas = perf.spend > 0 ? perf.gmv / perf.spend : null
          campaigns.push({
            kind: 'ads', status,
            title: ci.ad_name ?? perf.name ?? `Ads ${id}`,
            config: {
              ad_type, bidding_method: ci.bidding_method ?? null,
              campaign_placement: ci.campaign_placement ?? null,
              budget: ci.campaign_budget ?? null,
              roas: roas != null ? Number(roas.toFixed(2)) : null,
              impressions: perf.impr, clicks: perf.clk, window_days: 30,
            },
            starts_at: startSec > 0 ? new Date(startSec * 1000).toISOString() : nowIso,
            ends_at:   endSec > 0 ? new Date(endSec * 1000).toISOString() : null,
            external_id: String(id),
            raw: { setting: ci, perf },
            revenue_cents: Math.round(perf.gmv * 100),
            cost_cents:    Math.round(perf.spend * 100),
            orders:        perf.orders,
          })
        }
      }
    } catch (e: unknown) {
      errors.push(`ads: ${(e as Error)?.message}`)
    }

    return { campaigns, errors }
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
