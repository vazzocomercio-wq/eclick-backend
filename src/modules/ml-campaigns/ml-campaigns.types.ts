/** Types do F8 ML Campaign Center IA — Camada 1.
 *  Shape valido pos-smoke-test em VAZZO_ (seller 2290161131). */

export type MlPromotionType =
  | 'MARKETPLACE_CAMPAIGN' | 'DEAL' | 'PRICE_DISCOUNT'
  | 'LIGHTNING' | 'DOD' | 'VOLUME' | 'PRE_NEGOTIATED'
  | 'SELLER_CAMPAIGN' | 'SMART' | 'PRICE_MATCHING'
  | 'UNHEALTHY_STOCK' | 'SELLER_COUPON_CAMPAIGN'

export type MlCampaignStatus = 'pending' | 'started' | 'finished' | 'paused' | 'expired'
export type MlItemStatus     = 'candidate' | 'pending' | 'started' | 'finished'

/** GET /seller-promotions/users/:id?app_version=v2
 *  IMPORTANTE: LIGHTNING retorna shape mínimo (só id/type/status).
 *  SMART/DEAL retornam shape completo. */
export interface MlPromotionListItem {
  id:             string
  type:           MlPromotionType
  status:         MlCampaignStatus
  name?:          string
  start_date?:    string
  finish_date?:   string
  deadline_date?: string
}

/** GET /seller-promotions/promotions/:id/items?promotion_type=X&status=Y
 *  Shape varia por status:
 *  - candidate: tem original_price + min/max/suggested_discounted_price (NÃO tem price)
 *  - started:   tem price + original_price (já participando) */
export interface MlPromotionItem {
  id:                          string                // ml_item_id
  ref_id?:                     string                // CANDIDATE-MLBxxx-... identifier
  status:                      MlItemStatus
  original_price?:             number
  price?:                      number                // só quando started
  suggested_discounted_price?: number
  min_discounted_price?:       number
  max_discounted_price?:       number
  max_top_discounted_price?:   number                // preço pra Meli+ premium
  stock?: { min: number; max: number }               // LIGHTNING tem
  // Subsídio NÃO vem aqui — só em /seller-promotions/items/:itemId
}

/** GET /seller-promotions/items/:itemId?app_version=v2
 *  Endpoint que TEM o subsídio MELI (meli_percentage / seller_percentage).
 *  Retorna ARRAY de promoções (pode ter 1 item em N campanhas). */
export interface MlItemPromotion {
  id:                  string                       // ml_campaign_id
  type:                MlPromotionType
  ref_id?:             string                       // CANDIDATE-... ou OFFER-...
  status:              MlItemStatus
  name?:               string
  offer_id?:           string                       // se já participa
  price?:              number
  original_price?:     number
  meli_percentage?:    number                       // % subsidiado pelo ML
  seller_percentage?:  number                       // % desconto seller
  // Outros campos
  start_date?:         string
  finish_date?:        string
  deadline_date?:      string
}

/** GET /seller-promotions/promotions/:id/items response com paginação */
export interface MlCampaignItemsResponse {
  results: MlPromotionItem[]
  paging?: { total: number; limit: number; searchAfter?: string }
}

/** GET /sites/MLB/listing_prices */
export interface MlListingPricesResponse {
  listing_type_id?:    string
  sale_fee_amount?:    number
  sale_fee_details?: {
    fixed_fee?:          number
    gross_amount?:       number
    percentage_fee?:     number
  }
  free_shipping_cost?: number
}

// ── Internal types ─────────────────────────────────────────────────

export interface HealthAssessment {
  status:          'ready' | 'missing_cost' | 'missing_tax' | 'missing_shipping' | 'incomplete'
  has_cost_data:   boolean
  has_tax_data:    boolean
  has_dimensions:  boolean
  warnings:        Array<{ code: string; message: string }>
}

export interface MlCampaignsSyncResult {
  log_id:                      string
  campaigns_processed:         number
  items_processed:             number
  items_subsidy_enriched:      number
  api_calls_count:             number
  duration_seconds:            number
}
