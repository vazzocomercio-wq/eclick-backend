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
        response_optional_fields: 'item_list,total_amount,actual_shipping_fee,estimated_shipping_fee,payment_method,buyer_cpf_id,recipient_address,buyer_user_id,buyer_username,pay_time,invoice_data,package_list',
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

  /** Endereço do destinatário via DOCUMENTO DE ENVIO (etiqueta). A Shopee
   *  mascara o recipient_address do get_order_detail, mas a etiqueta carrega
   *  o endereço completo — disponível SÓ na janela entre "Organizar Envio"
   *  (ship_order) e o despacho. Cria o documento (mesmo AWB que o Seller
   *  Center imprime; criar de novo não quebra nada) e lê os dados. Lança
   *  fora da janela — caller trata como skip silencioso. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchShippingDocumentRecipient(conn: MpConnection, orderSn: string, packageNumber: string): Promise<Record<string, any> | null> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const post = async (apiPath: string, body: Record<string, unknown>) => {
      const ts = Math.floor(Date.now() / 1000)
      const sign = this.signShop(apiPath, ts, accessToken, shopId)
      const qs = new URLSearchParams({
        partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
        shop_id: String(shopId), sign,
      })
      const { data } = await this.callShopee({
        key: `shop:${shopId}`, tag: 'shopee.shippingDoc',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.post<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`, body),
      })
      return data
    }

    // 1) data_info ANTES do create — dele sai o tracking_number (o create
    //    sem tracking falha com logistics.tracking_number_invalid no SPX BR;
    //    validado ao vivo 2026-07-05)
    const readInfo = () => post('/api/v2/logistics/get_shipping_document_data_info', {
      order_sn: orderSn, package_number: packageNumber,
    })
    // recipient pode vir em recipient_address_info (chave real do SPX BR),
    // shipping_document_info.recipient_address ou no topo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pickRecipient = (resp: any) =>
      resp?.recipient_address_info
      ?? resp?.shipping_document_info?.recipient_address
      ?? resp?.recipient_address
      ?? null

    let info = await readInfo()
    if (info?.error) throw new Error(`Shopee get_shipping_document_data_info ${info.error}: ${info.message}`)
    let rcpt = pickRecipient(info?.response)

    // 2) sem recipient ainda → cria o documento (com tracking) e relê.
    //    ⚠️ SPX BR hoje devolve recipient_address_info=null mesmo com o
    //    documento criado (endereço aberto só existe no PDF da etiqueta) —
    //    o caminho fica pronto caso a Shopee passe a popular o campo.
    if (!rcpt) {
      const tracking = info?.response?.shipping_document_info?.shopee_tracking_number
        ?? info?.response?.shipping_document_info?.tracking_number
      await post('/api/v2/logistics/create_shipping_document', {
        order_list: [{
          order_sn: orderSn, package_number: packageNumber,
          ...(tracking ? { tracking_number: String(tracking) } : {}),
          shipping_document_type: 'NORMAL_AIR_WAYBILL',
        }],
      }).catch(() => null)
      info = await readInfo()
      rcpt = pickRecipient(info?.response)
    }
    this.logger.log(`[shopee.shippingDoc] ${orderSn} recipient=${JSON.stringify(rcpt) ?? 'null'}`)
    return rcpt as Record<string, unknown> | null
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

  /** Devoluções/reembolsos da loja (returns API). Paginado por page_no
   *  (0-based) — devolve a página crua + flag more. Shape validado live:
   *  return_sn, order_sn, status (REQUESTED/PROCESSING/ACCEPTED/JUDGING/
   *  REFUND_PAID/CLOSED/CANCELLED...), reason, text_reason, refund_amount,
   *  currency, create_time/update_time (epoch s), due_date, item[],
   *  user{username}, image[], buyer_videos[], tracking_number,
   *  needs_logistics, negotiation/seller_proof quando em disputa. */
  async listReturns(
    conn: MpConnection,
    opts: { pageNo?: number; pageSize?: number; createTimeFrom?: Date; createTimeTo?: Date } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ returns: any[]; more: boolean }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/returns/get_return_list'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign,
      page_no:   String(opts.pageNo ?? 0),
      page_size: String(opts.pageSize ?? 50),
    })
    if (opts.createTimeFrom) qs.set('create_time_from', String(Math.floor(opts.createTimeFrom.getTime() / 1000)))
    if (opts.createTimeTo)   qs.set('create_time_to',   String(Math.floor(opts.createTimeTo.getTime() / 1000)))
    const { data } = await this.callShopee({
      key: `shop:${shopId}`,
      tag: 'shopee.listReturns',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    return {
      returns: data?.response?.return ?? [],
      more:    Boolean(data?.response?.more),
    }
  }

  // ── returns API de AÇÃO (playbook de devoluções) ────────────────────────
  // Probe 2026-06-12 confirmou escopo de ESCRITA liberado (todos os endpoints
  // validam params em vez de error_api_permission). Shapes do detail/dispute
  // reasons validados live na loja Vazzo.

  /** GET genérico da returns API (sign shop-level + querystring). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async returnsGet(conn: MpConnection, apiPath: string, extra: Record<string, string>): Promise<any> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign, ...extra,
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: `shopee.returns${apiPath.split('/').pop()}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    return data?.response ?? {}
  }

  /** POST genérico da returns API (ações). NÃO lança em erro da Shopee —
   *  devolve {error,message,response} cru pro caller converter em mensagem
   *  acionável (e calibrar shapes pelo log na 1ª execução real). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async returnsPost(conn: MpConnection, apiPath: string, body: Record<string, unknown>): Promise<any> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign,
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: `shopee.returns${apiPath.split('/').pop()}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`, body),
    })
    this.logger.log(`[shopee.returns.action] ${apiPath} body=${JSON.stringify(body).slice(0, 300)} → ${JSON.stringify(data).slice(0, 500)}`)
    return data
  }

  /** Detalhe RICO de uma devolução — muito mais que a list: negotiation
   *  (oferta pendente do comprador, counter_limit), seller_proof, prazos
   *  extras (return_ship_due_date), logistics_status, validation_type. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getReturnDetail(conn: MpConnection, returnSn: string): Promise<any> {
    return this.returnsGet(conn, '/api/v2/returns/get_return_detail', { return_sn: returnSn })
  }

  /** Motivos de disputa válidos PRA ESTA devolução + requisitos de evidência
   *  (texto em PT-BR vindo da própria Shopee). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getReturnDisputeReasons(conn: MpConnection, returnSn: string): Promise<any[]> {
    const resp = await this.returnsGet(conn, '/api/v2/returns/get_return_dispute_reason', { return_sn: returnSn })
    return resp?.dispute_reason_list ?? []
  }

  /** Soluções disponíveis (oferta de reembolso parcial/total sem devolução,
   *  com elegibilidade + teto de valor). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getReturnSolutions(conn: MpConnection, returnSn: string): Promise<any> {
    return this.returnsGet(conn, '/api/v2/returns/get_available_solutions', { return_sn: returnSn })
  }

  /** ⚠️ ESCRITA REAL — aceita a devolução/reembolso (confirm). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async confirmReturn(conn: MpConnection, returnSn: string): Promise<any> {
    return this.returnsPost(conn, '/api/v2/returns/confirm', { return_sn: returnSn })
  }

  /** ⚠️ ESCRITA REAL — abre disputa contra a devolução. dispute_reason vem
   *  do getReturnDisputeReasons; images = URLs de evidência (fotos do
   *  recebimento ou as do próprio comprador quando provam a NOSSA tese). */
  async disputeReturn(conn: MpConnection, returnSn: string, opts: {
    email?:             string
    disputeReason:      number
    disputeTextReason?: string
    images?:            string[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<any> {
    const body: Record<string, unknown> = {
      return_sn:      returnSn,
      dispute_reason: opts.disputeReason,
    }
    if (opts.email)             body.email = opts.email
    if (opts.disputeTextReason) body.dispute_text_reason = opts.disputeTextReason
    if (opts.images?.length)    body.image = opts.images
    return this.returnsPost(conn, '/api/v2/returns/dispute', body)
  }

  /** ⚠️ ESCRITA REAL — aceita a OFERTA pendente do comprador (negotiation). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async acceptReturnOffer(conn: MpConnection, returnSn: string): Promise<any> {
    return this.returnsPost(conn, '/api/v2/returns/accept_offer', { return_sn: returnSn })
  }

  // ── avaliações (product/get_comment + reply_comment) ────────────────────

  /** Avaliações da loja (shop-level, paginado por cursor). Shape validado
   *  live: comment_id, comment (texto; vazio = só estrelas), buyer_username,
   *  order_sn, item_id, model_id, create_time, rating_star (1-5), editable
   *  (EDITABLE/EXPIRED), hidden, media{image_url_list?,video_url_list?},
   *  comment_reply{reply,hidden} quando já respondida. */
  async listItemComments(
    conn: MpConnection,
    opts: { cursor?: string; pageSize?: number; itemId?: number | string } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ comments: any[]; more: boolean; nextCursor: string | null }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/get_comment'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign,
      cursor:    opts.cursor ?? '',
      page_size: String(opts.pageSize ?? 50),
    })
    if (opts.itemId != null) qs.set('item_id', String(opts.itemId))
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.listComments',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    const resp = data?.response ?? {}
    return {
      comments:   resp.item_comment_list ?? [],
      more:       Boolean(resp.more),
      nextCursor: resp.next_cursor != null ? String(resp.next_cursor) : null,
    }
  }

  /** Responde avaliações (até 100 por chamada). ⚠️ resposta PÚBLICA no
   *  anúncio — irreversível na prática (Shopee não deixa editar depois). */
  async replyComments(
    conn: MpConnection,
    replies: Array<{ commentId: number | string; comment: string }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/reply_comment'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const body = {
      comment_list: replies.map(r => ({ comment_id: Number(r.commentId), comment: r.comment })),
    }
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.replyComment',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    // result_list traz fail_error por comment quando algo falha (parse defensivo)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fails = (data?.response?.result_list ?? []).filter((r: any) => r?.fail_error)
    if (fails.length) {
      throw new Error(`Shopee reply_comment falhou: ${JSON.stringify(fails[0])}`)
    }
    this.logger.log(`[shopee.replyComment] ${replies.length} resposta(s) publicada(s) shop=${shopId}`)
    return data?.response ?? data
  }

  // ── sellerchat (chat com comprador) ─────────────────────────────────────
  // ⚠️ Exige a permissão "Chat" do app no Open Platform (hoje o app e-Click
  // recebe error_api_permission — ação do user no console). Shapes baseados
  // na doc v2 — parse defensivo + log do raw pra calibrar na 1ª chamada real.

  /** Lista conversas do sellerchat (mais recentes primeiro). */
  async chatGetConversationList(
    conn: MpConnection,
    opts: { pageSize?: number; nextTimestampNano?: string; type?: 'all' | 'unread' | 'pinned' } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ conversations: any[]; nextTimestampNano: string | null; more: boolean }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/sellerchat/get_conversation_list'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign,
      direction: 'latest',
      type:      opts.type ?? 'all',
      page_size: String(opts.pageSize ?? 25),
    })
    if (opts.nextTimestampNano) qs.set('next_timestamp_nano', opts.nextTimestampNano)
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.chatList',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    const resp = data?.response ?? {}
    return {
      conversations:     resp.conversations ?? [],
      nextTimestampNano: resp.page_result?.next_cursor?.next_message_time_nano ?? null,
      more:              Boolean(resp.page_result?.more ?? resp.more),
    }
  }

  /** Mensagens de UMA conversa (mais recentes primeiro; offset pagina pra trás). */
  async chatGetMessages(
    conn: MpConnection,
    conversationId: string,
    opts: { pageSize?: number; offset?: string } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ messages: any[]; nextOffset: string | null }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/sellerchat/get_message'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken,
      shop_id: String(shopId), sign,
      conversation_id: conversationId,
      page_size:       String(opts.pageSize ?? 30),
    })
    if (opts.offset) qs.set('offset', opts.offset)
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.chatMessages',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    const resp = data?.response ?? {}
    return {
      messages:   resp.messages ?? [],
      nextOffset: resp.page_result?.next_offset ?? null,
    }
  }

  /** Envia mensagem de TEXTO pro comprador. ⚠️ mensagem REAL pro cliente. */
  async chatSendMessage(
    conn: MpConnection,
    toId: number | string,
    text: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/sellerchat/send_message'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const body = { to_id: Number(toId), message_type: 'text', content: { text } }
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.chatSend',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    this.logger.log(`[shopee.chatSend] to=${toId} → ${JSON.stringify(data?.response ?? data).slice(0, 300)}`)
    return data?.response ?? data
  }

  /** Marca a conversa como lida até a mensagem informada. */
  async chatReadConversation(
    conn: MpConnection,
    conversationId: string,
    lastReadMessageId: string,
  ): Promise<void> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/sellerchat/read_conversation'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const body = { conversation_id: conversationId, last_read_message_id: lastReadMessageId }
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.chatRead',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
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
  /** Lê os time slots de Oferta Relâmpago da loja (próximos 7 dias). Serve de
   *  PROBE de escopo do módulo shop_flash_sale: se devolver 403, o app não tem
   *  permissão de gestão de promoções (igual ao bloqueio do Ads). Read-only.
   *  Path correto = get_time_slot_id (o antigo get_shop_flash_sale_time_slot_id
   *  dava 404). start_time precisa ser > agora (buffer 120s contra clock skew —
   *  validado live: now seco deu "start_time should be >= now"). */
  async getFlashSaleTimeSlots(conn: MpConnection): Promise<{ ok: boolean; slots: Array<{ timeslot_id: number; start_time: number; end_time: number }>; error?: string }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const path = '/api/v2/shop_flash_sale/get_time_slot_id'
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(path, ts, accessToken, shopId)
    const startTime = ts + 120
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

  // ══ F18 Promo WRITE — Voucher + Shop Flash Sale (Campaign Center escrita) ══
  // Probe 2026-06-12: módulo voucher + shop_flash_sale SEM bloqueio de escopo
  // (≠ Ads/add_item). Todos os writes logam o raw (parse defensivo) — shapes
  // calibram na 1ª chamada real.

  /** Helper POST shop-level assinado (boilerplate dos writes de promoção). */
  private async postPromo(conn: MpConnection, apiPath: string, body: Record<string, unknown>, tag: string): Promise<unknown> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const ts   = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url  = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts), access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    this.logger.log(`[${tag}] → ${JSON.stringify(data)?.slice(0, 400)}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((data as any)?.error) throw new Error(`Shopee ${apiPath.split('/').pop()} ${(data as any).error}: ${(data as any).message}`)
    return data
  }

  /** Cria um Voucher (cupom) na loja. `POST /api/v2/voucher/add_voucher`.
   *  reward_type: 1=valor fixo (discount_amount R$), 2=percentual (percentage
   *  1-99 + max_price teto R$ — OBRIGATÓRIO no percentual, calibrado live
   *  2026-06-12: "max_price is required"). voucher_type: 1=loja toda, 2=produtos
   *  (item_id_list, máx 50). voucher_code: 1-5 chars A-Z/0-9 (a Shopee prefixa
   *  com o código da loja). Datas Unix s; start >= agora. ⚠️ cria voucher REAL. */
  async addVoucher(conn: MpConnection, args: {
    name: string; code: string; startTime: number; endTime: number
    voucherType: 1 | 2; rewardType: 1 | 2
    discountAmount?: number; percentage?: number; maxPrice?: number
    minBasketPrice: number; usageQuantity: number
    itemIdList?: number[]; displayStartTime?: number
  }): Promise<{ voucher_id: number; raw: unknown }> {
    const body: Record<string, unknown> = {
      voucher_name:     args.name.slice(0, 100),
      voucher_code:     args.code.slice(0, 5).toUpperCase(),
      start_time:       args.startTime,
      end_time:         args.endTime,
      voucher_type:     args.voucherType,
      reward_type:      args.rewardType,
      usage_quantity:   args.usageQuantity,
      min_basket_price: args.minBasketPrice,
    }
    if (args.rewardType === 1) body.discount_amount = args.discountAmount
    if (args.rewardType === 2) {
      body.percentage = args.percentage
      if (args.maxPrice != null && args.maxPrice > 0) body.max_price = args.maxPrice
    }
    if (args.voucherType === 2 && args.itemIdList?.length) body.item_id_list = args.itemIdList.slice(0, 50)
    if (args.displayStartTime != null) body.display_start_time = args.displayStartTime
    const data = await this.postPromo(conn, '/api/v2/voucher/add_voucher', body, 'shopee.addVoucher')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (data as any)?.response?.voucher_id
    if (!id) throw new Error(`Shopee add_voucher sem voucher_id: ${JSON.stringify(data)?.slice(0, 200)}`)
    return { voucher_id: Number(id), raw: data }
  }

  /** Atualiza um Voucher existente. `POST /api/v2/voucher/update_voucher`.
   *  Campos opcionais — só envia o que mudou (Shopee restringe edição após
   *  início: período/quantidade ainda editáveis, desconto não). */
  async updateVoucher(conn: MpConnection, args: {
    voucherId: number; name?: string; startTime?: number; endTime?: number
    minBasketPrice?: number; usageQuantity?: number; maxPrice?: number
  }): Promise<{ raw: unknown }> {
    const body: Record<string, unknown> = { voucher_id: args.voucherId }
    if (args.name != null)           body.voucher_name = args.name.slice(0, 100)
    if (args.startTime != null)      body.start_time = args.startTime
    if (args.endTime != null)        body.end_time = args.endTime
    if (args.minBasketPrice != null) body.min_basket_price = args.minBasketPrice
    if (args.usageQuantity != null)  body.usage_quantity = args.usageQuantity
    if (args.maxPrice != null)       body.max_price = args.maxPrice
    const data = await this.postPromo(conn, '/api/v2/voucher/update_voucher', body, 'shopee.updateVoucher')
    return { raw: data }
  }

  /** Encerra um Voucher EM ANDAMENTO agora. `POST /api/v2/voucher/end_voucher`.
   *  (Voucher upcoming usa delete_voucher.) */
  async endVoucher(conn: MpConnection, voucherId: number): Promise<{ raw: unknown }> {
    const data = await this.postPromo(conn, '/api/v2/voucher/end_voucher', { voucher_id: voucherId }, 'shopee.endVoucher')
    return { raw: data }
  }

  /** Apaga um Voucher AINDA NÃO INICIADO. `POST /api/v2/voucher/delete_voucher`. */
  async deleteVoucher(conn: MpConnection, voucherId: number): Promise<{ raw: unknown }> {
    const data = await this.postPromo(conn, '/api/v2/voucher/delete_voucher', { voucher_id: voucherId }, 'shopee.deleteVoucher')
    return { raw: data }
  }

  /** Cria uma Oferta Relâmpago (sessão vazia) num time slot. `POST
   *  /api/v2/shop_flash_sale/add_shop_flash_sale`. Itens entram depois via
   *  addShopFlashSaleItems. ⚠️ cria flash sale REAL (agendada no slot). */
  async createShopFlashSale(conn: MpConnection, timeslotId: number): Promise<{ flash_sale_id: number; raw: unknown }> {
    const data = await this.postPromo(conn, '/api/v2/shop_flash_sale/add_shop_flash_sale', { timeslot_id: timeslotId }, 'shopee.addFlashSale')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (data as any)?.response?.flash_sale_id
    if (!id) throw new Error(`Shopee add_shop_flash_sale sem flash_sale_id: ${JSON.stringify(data)?.slice(0, 200)}`)
    return { flash_sale_id: Number(id), raw: data }
  }

  /** Adiciona itens a uma Oferta Relâmpago. `POST /api/v2/shop_flash_sale/
   *  add_shop_flash_sale_items`. Item COM variação → models[]; SEM variação →
   *  ainda assim a Shopee espera models com model_id 0 (parse defensivo: a
   *  failed_items[] da resposta diz o motivo por item). stock = qtd reservada
   *  pra promo (≤ estoque real). ⚠️ promo REAL. */
  async addShopFlashSaleItems(conn: MpConnection, args: {
    flashSaleId: number
    items: Array<{
      item_id: number
      purchase_limit?: number
      models: Array<{ model_id: number; input_promo_price: number; stock: number }>
    }>
  }): Promise<{ failed: unknown[]; raw: unknown }> {
    const body = {
      flash_sale_id: args.flashSaleId,
      items: args.items.map(it => ({
        item_id: it.item_id,
        purchase_limit: it.purchase_limit ?? 0,
        models: it.models.map(m => ({ model_id: m.model_id, input_promo_price: m.input_promo_price, stock: m.stock })),
      })),
    }
    const data = await this.postPromo(conn, '/api/v2/shop_flash_sale/add_shop_flash_sale_items', body, 'shopee.addFlashSaleItems')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failed = ((data as any)?.response?.failed_items ?? []) as unknown[]
    return { failed, raw: data }
  }

  /** Habilita/desabilita uma Oferta Relâmpago. `POST /api/v2/shop_flash_sale/
   *  update_shop_flash_sale`. status: 1=enable, 2=disable. */
  async updateShopFlashSale(conn: MpConnection, args: { flashSaleId: number; status: 1 | 2 }): Promise<{ raw: unknown }> {
    const data = await this.postPromo(conn, '/api/v2/shop_flash_sale/update_shop_flash_sale', { flash_sale_id: args.flashSaleId, status: args.status }, 'shopee.updateFlashSale')
    return { raw: data }
  }

  /** Remove uma Oferta Relâmpago inteira. `POST /api/v2/shop_flash_sale/
   *  delete_shop_flash_sale`. (Rollback do create.) */
  async deleteShopFlashSale(conn: MpConnection, flashSaleId: number): Promise<{ raw: unknown }> {
    const data = await this.postPromo(conn, '/api/v2/shop_flash_sale/delete_shop_flash_sale', { flash_sale_id: flashSaleId }, 'shopee.deleteFlashSale')
    return { raw: data }
  }

  /** Remove itens de uma Oferta Relâmpago. `POST /api/v2/shop_flash_sale/
   *  delete_shop_flash_sale_items`. */
  async deleteShopFlashSaleItems(conn: MpConnection, args: { flashSaleId: number; itemIds: number[] }): Promise<{ raw: unknown }> {
    const data = await this.postPromo(conn, '/api/v2/shop_flash_sale/delete_shop_flash_sale_items', { flash_sale_id: args.flashSaleId, item_ids: args.itemIds }, 'shopee.deleteFlashSaleItems')
    return { raw: data }
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

  /** Gasto DIÁRIO de Shopee Ads por campanha (últimos `days` dias) — alimenta
   *  o ledger `platform_charges` (categoria ads). Mesmo módulo 105 do
   *  getCampaigns: exige o escopo Ads habilitado no app (senão
   *  error_api_permission — caller trata). Data defensiva: a API devolve
   *  metrics_list por dia; aceita `date` DD-MM-YYYY, YYYY-MM-DD ou epoch. */
  async getAdsDailySpend(conn: MpConnection, days = 30): Promise<{
    rows: Array<{ campaign_id: string; name: string | null; date: string; expense: number; gmv: number }>
    errors: string[]
  }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const errors: string[] = []
    const rows: Array<{ campaign_id: string; name: string | null; date: string; expense: number; gmv: number }> = []

    const qs = (path: string, extra: Record<string, string>): string => {
      const ts = Math.floor(Date.now() / 1000)
      const sign = this.signShop(path, ts, accessToken, shopId)
      return new URLSearchParams({
        partner_id: partnerId, timestamp: String(ts),
        access_token: accessToken, shop_id: String(shopId), sign, ...extra,
      }).toString()
    }
    const toIsoDate = (v: unknown): string | null => {
      if (v == null) return null
      const s = String(v)
      let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/)          // DD-MM-YYYY
      if (m) return `${m[3]}-${m[2]}-${m[1]}`
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)                // YYYY-MM-DD
      if (m) return `${m[1]}-${m[2]}-${m[3]}`
      const n = Number(s)                                    // epoch (segundos)
      if (Number.isFinite(n) && n > 1e9) return new Date(n * 1000).toISOString().slice(0, 10)
      return null
    }

    try {
      // probe de permissão (módulo 105)
      const balPath = '/api/v2/ads/get_total_balance'
      const { data: bal } = await this.callShopee({
        key: `shop:${shopId}`, tag: 'shopee.adsBalance',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exec: () => axios.get<any>(`${SHOPEE_BASE}${balPath}?${qs(balPath, {})}`),
      })
      if (bal?.error) throw new Error(`${bal.error}: ${bal.message}`)

      const adIds: number[] = []
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
        for (const c of list) if (c?.campaign_id != null) adIds.push(Number(c.campaign_id))
        if (!data?.response?.has_next_page || list.length === 0) break
        offset += list.length
        if (offset > 10000) break
      }

      const pad = (n: number) => String(n).padStart(2, '0')
      const ddmmyyyy = (d: Date) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`
      const endD = new Date()
      const startD = new Date(Date.now() - Math.min(days, 30) * 86400 * 1000)

      for (let i = 0; i < adIds.length; i += 100) {
        const chunk = adIds.slice(i, i + 100).join(',')
        const pPath = '/api/v2/ads/get_product_campaign_daily_performance'
        const { data: pData } = await this.callShopee({
          key: `shop:${shopId}`, tag: 'shopee.adsPerfDaily',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          exec: () => axios.get<any>(`${SHOPEE_BASE}${pPath}?${qs(pPath, { start_date: ddmmyyyy(startD), end_date: ddmmyyyy(endD), campaign_id_list: chunk })}`),
        })
        if (pData?.error) throw new Error(`${pData.error}: ${pData.message}`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const sh of (pData?.response ?? []) as any[]) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const c of (sh?.campaign_list ?? []) as any[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const m of (c?.metrics_list ?? []) as any[]) {
              const date = toIsoDate(m?.date ?? m?.calc_date ?? m?.day)
              const expense = Number(m?.expense) || 0
              if (!date) {
                if (expense > 0) errors.push(`campaign ${c?.campaign_id}: metric sem data reconhecível (keys: ${Object.keys(m ?? {}).join(',')})`)
                continue
              }
              if (expense <= 0) continue
              rows.push({
                campaign_id: String(c.campaign_id),
                name: c?.ad_name ?? null,
                date,
                expense,
                gmv: Number(m?.broad_gmv) || 0,
              })
            }
          }
        }
      }
    } catch (e: unknown) {
      errors.push(`ads_daily: ${(e as Error)?.message}`)
    }
    return { rows, errors }
  }

  /** F0.3/F0.5 — webhook Push. Shopee envia header `Authorization` com
   *  HMAC-SHA256(push_key, `${url}|${body}`) em hex lowercase. Validação
   *  síncrona (sem fetch). rawBody DEVE ser o body cru (não JSON.parsed) —
   *  parse perde whitespace e quebra o hash. URL é a do receptor REGISTRADO
   *  no Shopee Partner Center (não a URL local da request — host/proxy podem
   *  diferir). Caller passa via `input.url`.
   *
   *  ⚠️ A chave do push NÃO é a partner key da API: é a "Live Push Partner
   *  Key" exibida no console em Push Mechanism → Set Push (validado offline
   *  contra eventos reais 2026-06-12 — era a causa de 100% sig inválida). */
  validateWebhookSignature(input: WebhookValidationInput): boolean {
    const { headers, url, rawBody, secret } = input
    const partnerKey = secret
      ?? process.env.SHOPEE_PUSH_PARTNER_KEY
      ?? process.env.SHOPEE_PARTNER_KEY
    if (!partnerKey) {
      this.logger.error('[shopee.webhook] SHOPEE_PUSH_PARTNER_KEY/SHOPEE_PARTNER_KEY ausentes')
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

  // ── Auto-Boost (boost GRATUITO "Impulsionar agora") ──────────────────────
  // Validado live 2026-06-12 nas 2 lojas Vazzo: 5 slots simultâneos por loja
  // (6º item → product.error_busi "reached shop's bump slot limit"), cada
  // boost dura 4h (cool_down_second ≈ 14400 logo após o boost).

  /** Itens em boost AGORA na loja, com o tempo restante de cada um. */
  async getBoostedList(conn: MpConnection): Promise<Array<{ item_id: number; cool_down_second: number }>> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/get_boosted_list'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const qs = new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    })
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.getBoostedList',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.get<any>(`${SHOPEE_BASE}${apiPath}?${qs.toString()}`),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data?.response?.item_list ?? []).map((it: any) => ({
      item_id:          Number(it.item_id),
      cool_down_second: Number(it.cool_down_second ?? 0),
    }))
  }

  /** Aplica o boost gratuito em até 5 itens. Resposta separa sucesso/falha
   *  (falha por item vem em failure_list quando parcial; estourar o teto de
   *  slots vem como erro top-level product.error_busi). */
  async boostItems(conn: MpConnection, itemIds: Array<number | string>): Promise<{
    success: number[]
    failures: Array<{ item_id: number; reason: string }>
  }> {
    const { accessToken, shopId } = this.requireShop(conn)
    const { partnerId } = this.partnerEnv()
    const apiPath = '/api/v2/product/boost_item'
    const ts = Math.floor(Date.now() / 1000)
    const sign = this.signShop(apiPath, ts, accessToken, shopId)
    const url = `${SHOPEE_BASE}${apiPath}?` + new URLSearchParams({
      partner_id: partnerId, timestamp: String(ts),
      access_token: accessToken, shop_id: String(shopId), sign,
    }).toString()
    const body = { item_id_list: itemIds.slice(0, 5).map(Number) }
    const { data } = await this.callShopee({
      key: `shop:${shopId}`, tag: 'shopee.boostItem',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exec: () => axios.post<any>(url, body),
    })
    if (data?.error) throw new Error(`Shopee ${data.error}: ${data.message}`)
    const success = (data?.response?.success_list?.item_id_list ?? []).map(Number)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failures = (data?.response?.failure_list ?? []).map((f: any) => ({
      item_id: Number(f?.item_id),
      reason:  String(f?.failed_reason ?? f?.reason ?? 'desconhecido'),
    }))
    this.logger.log(`[shopee.boost] shop=${shopId} ok=${success.length} fail=${failures.length}`)
    return { success, failures }
  }
}
