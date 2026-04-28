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
}
