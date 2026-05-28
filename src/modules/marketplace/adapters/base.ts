import { NotImplementedException } from '@nestjs/common'

/** Adapter pattern pra unificar pedidos de múltiplos marketplaces.
 * Cada plataforma (ML, Shopee, Magalu, Amazon) implementa essa interface;
 * o registry dispatcha por platform e o OrdersIngestionService chama via
 * interface comum. Mantém o código de negócio (kit/vinculos, billing
 * trigger, etc) agnóstico de plataforma. */

export type MarketplacePlatform = 'mercadolivre' | 'shopee' | 'amazon' | 'magalu'

export interface MpConnection {
  id:               string
  organization_id:  string
  platform:         MarketplacePlatform
  seller_id?:       number | null
  shop_id?:         number | null
  partner_id?:      number | null
  marketplace_id?:  string | null
  external_id?:     string | null
  access_token:     string | null
  refresh_token:    string | null
  expires_at:       string | null
  /** Plain object — service_decifrou de config_encrypted antes de passar pro adapter. */
  config?:          Record<string, unknown> | null
  nickname?:        string | null
  status?:          string | null
}

export interface AddressShape {
  country_id?:    string | null
  zip_code?:      string | null
  state?:         string | null
  city_name?:     string | null
  neighborhood?:  string | null
  street_name?:   string | null
  street_number?: string | null
  complement?:    string | null
}

export interface BuyerBilling {
  doc_type:         'CPF' | 'CNPJ' | null
  doc_number:       string | null
  email:            string | null
  phone:            string | null
  name:             string | null
  last_name:        string | null
  /** Identificador externo de billing dentro da plataforma (ex: ML billing_info_id). */
  billing_info_id:  string | null
  billing_address:  AddressShape | null
  billing_country:  string | null
}

export interface RawOrder {
  /** ID do pedido na plataforma (string pra cobrir uint64 do Shopee). */
  external_order_id: string
  /** Resposta crua da API — guardado em orders.raw_data pra debug futuro. */
  raw:               unknown
  /** Date pulled from native field (Shopee create_time, Magalu created_at, etc). */
  created_at?:       string
  status?:           string
}

export interface TokenPair {
  access_token:  string
  refresh_token: string
  expires_at:    string
}

// ── F0.5 — tipos novos pra cobertura completa (publish, stock, ship, escrow) ─

/** Anúncio/produto retornado por `listProducts`. Shape comum cross-platform;
 *  campos específicos vão em `raw`. variation_id = modelId Shopee = variation Magalu. */
export interface RawListing {
  external_product_id:    string
  external_variation_id?: string | null
  title?:                 string | null
  price?:                 number | null
  stock?:                 number | null
  status?:                string | null
  raw:                    unknown
}

/** Resultado de operações de mutação (updateStock/updatePrice/shipOrder). */
export interface UpdateResult {
  ok:                     boolean
  external_product_id?:   string
  external_variation_id?: string | null
  external_order_id?:     string
  raw?:                   unknown
}

export interface ShippingLabelRequest {
  external_order_id: string
  /** Shopee package_number, ML shipment_id, etc — opcional, platform-specific. */
  package_info?:     Record<string, unknown>
}

/** Etiqueta de envio. ML é síncrono (PDF imediato), Shopee é assíncrono
 *  (devolve job_id; o consumidor faz polling com `getShippingLabel`). */
export interface ShippingLabelResult {
  external_order_id: string
  pdf_url?:          string | null
  pdf_base64?:       string | null
  tracking_number?:  string | null
  /** Token pra polling em fluxos assíncronos (Shopee). */
  job_id?:           string | null
  status:            'ready' | 'processing' | 'failed'
  raw?:              unknown
}

/** Detalhe de repasse (escrow) — Shopee escrow_detail; ML order.payments
 *  agregado; Magalu não expõe diretamente. Campos null quando platform
 *  não fornece. */
export interface EscrowDetail {
  external_order_id:   string
  gross_amount?:       number | null
  net_amount?:         number | null
  commission_amount?:  number | null
  shipping_fee?:       number | null
  raw:                 unknown
}

/** Entrada pra validação de webhook. rawBody é o BODY ORIGINAL (não-parsed)
 *  pra que o hash bata — JSON.parse perde whitespace e quebra HMAC. */
export interface WebhookValidationInput {
  /** Headers HTTP (case-insensitive). */
  headers: Record<string, string | string[] | undefined>
  /** URL completa (com query) — algumas plataformas (Shopee) assinam url|body. */
  url?:    string | null
  /** Body cru exatamente como veio na request. */
  rawBody: string
  /** Override do secret; default = env por plataforma (SHOPEE_PARTNER_KEY etc). */
  secret?: string
}

export abstract class MarketplaceAdapter {
  abstract readonly platform: MarketplacePlatform

  /** Lista pedidos do range. Backend pagina internamente até esgotar.
   * Retorna `RawOrder[]` — cada plataforma mantém o shape nativo no `raw`. */
  abstract listOrders(
    conn:  MpConnection,
    range: { from: Date; to: Date },
  ): Promise<RawOrder[]>

  /** Detalhe completo de 1 pedido. Algumas plataformas (ML) precisam call
   * separada pra billing; outras (Shopee/Magalu) já vem no detalhe. */
  abstract getOrderDetail(
    conn:           MpConnection,
    externalOrderId: string,
  ): Promise<RawOrder>

  /** Extrai buyer/billing do raw response no formato unificado. ML faz
   * call extra (/orders/billing-info); Shopee/Magalu lê do raw direto. */
  abstract extractBuyerBilling(
    raw:   RawOrder,
    conn:  MpConnection,
  ): Promise<BuyerBilling | null>

  /** Refresh access_token. Caller atualiza marketplace_connections.* */
  abstract refreshToken(conn: MpConnection): Promise<TokenPair>

  // ── F0.5 — 8 métodos novos (defaults throw NotImplemented; subclasses
  //         vão sobrescrevendo conforme F0.7/F1.6/F1.7 avançam) ──────────────

  /** Lista anúncios/produtos do vendedor (paginação cursor-based). Consumer
   *  passa cursor=null na 1ª call e itera enquanto nextCursor != null. */
  listProducts(
    _conn:   MpConnection,
    _cursor?: string | null,
  ): Promise<{ items: RawListing[]; nextCursor: string | null }> {
    return Promise.reject(this.notImplemented('listProducts'))
  }

  /** Atualiza estoque de 1 SKU/variação. */
  updateStock(
    _conn: MpConnection,
    _args: {
      externalProductId:    string
      externalVariationId?: string | null
      quantity:             number
    },
  ): Promise<UpdateResult> {
    return Promise.reject(this.notImplemented('updateStock'))
  }

  /** Atualiza preço de 1 SKU/variação. */
  updatePrice(
    _conn: MpConnection,
    _args: {
      externalProductId:    string
      externalVariationId?: string | null
      price:                number
    },
  ): Promise<UpdateResult> {
    return Promise.reject(this.notImplemented('updatePrice'))
  }

  /** Marca pedido como enviado (handoff pra logística). Shopee usa
   *  /logistics/ship_order; ML usa /shipments/{id}/items. */
  shipOrder(
    _conn: MpConnection,
    _args: {
      externalOrderId:  string
      trackingNumber?:  string | null
      packageInfo?:     Record<string, unknown>
    },
  ): Promise<UpdateResult> {
    return Promise.reject(this.notImplemented('shipOrder'))
  }

  /** Solicita etiqueta de envio. Shopee é ASSÍNCRONO (job_id pra polling);
   *  ML é SÍNCRONO (URL imediato). Consumer trata `status` pra decidir. */
  requestShippingLabel(
    _conn: MpConnection,
    _req:  ShippingLabelRequest,
  ): Promise<ShippingLabelResult> {
    return Promise.reject(this.notImplemented('requestShippingLabel'))
  }

  /** Polling pra etiqueta assíncrona (Shopee). ML retorna direto se chamado
   *  diretamente (mesma resposta do request). */
  getShippingLabel(
    _conn: MpConnection,
    _args: { externalOrderId: string; jobId?: string | null },
  ): Promise<ShippingLabelResult> {
    return Promise.reject(this.notImplemented('getShippingLabel'))
  }

  /** Detalhe de repasse — Shopee escrow_detail (taxa, comissão, frete);
   *  ML monta de order.payments[]; Magalu não expõe (devolve null fields). */
  getEscrowDetail(
    _conn:           MpConnection,
    _externalOrderId: string,
  ): Promise<EscrowDetail> {
    return Promise.reject(this.notImplemented('getEscrowDetail'))
  }

  /** Valida assinatura HMAC de webhook entrante. Síncrono (sem fetch);
   *  Shopee: HMAC-SHA256(partner_key, `${url}|${body}`) → header Authorization.
   *  ML/Magalu: schemas distintos. Cada adapter override. */
  validateWebhookSignature(_input: WebhookValidationInput): boolean {
    throw this.notImplemented('validateWebhookSignature')
  }

  /** Helper protegido — gera NotImplementedException padronizada com nome
   *  da plataforma e método pra facilitar debug do consumidor. */
  protected notImplemented(method: string): NotImplementedException {
    return new NotImplementedException(
      `${this.platform}.${method} ainda não implementado (F0.5 stub). ` +
      `Veja roadmap F18 pra cronograma.`,
    )
  }
}
