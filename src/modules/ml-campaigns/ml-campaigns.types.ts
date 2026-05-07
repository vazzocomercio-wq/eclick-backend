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

// ═══ Camada 2: Decision Engine ═════════════════════════════════════

export interface CostBreakdown {
  cost_price:              number    // custo do produto
  tax_amount:              number    // impostos (R$)
  tax_percentage:          number
  ml_commission:           number    // comissao ML (R$)
  ml_commission_pct:       number
  ml_fixed_fee:            number
  free_shipping_cost:      number
  packaging_cost:          number
  operational_cost:        number
  meli_subsidy_brl:        number    // R$ que ML reduz da tarifa (positivo = abate custo)
  total_costs:             number    // soma de tudo (com subsidio descontado)
  net_revenue:             number    // price - total_costs
}

export interface PriceScenario {
  price:                   number
  discount_pct:            number    // vs original_price
  margin_brl:              number    // M.C. R$
  margin_pct:              number    // M.C. %
  expected_volume:         'low' | 'medium' | 'high'
  rationale:               string
}

export interface PriceScenarios {
  conservative:            PriceScenario
  competitive:             PriceScenario
  aggressive:              PriceScenario
  break_even:              { price: number; rationale: string }
}

export interface QuantityRecommendation {
  current_stock:           number
  avg_daily_sales:         number
  campaign_duration_days:  number
  expected_demand_during:  number
  safety_stock:            number
  recommended_max_qty:     number
  stock_after_campaign:    number
  rupture_risk:            'low' | 'medium' | 'high'
  rationale:               string
}

export interface ScoreBreakdown {
  sales_potential:         number   // /30
  subsidy:                 number   // /20
  final_margin:            number   // /20
  stock_availability:      number   // /10
  stock_turnover_need:     number   // /10
  competitiveness:         number   // /10
  risk_penalty:            number   // negativo
  total:                   number   // 0-100
}

export type RecommendationType =
  | 'recommended'
  | 'recommended_caution'
  | 'clearance_only'
  | 'skip'
  | 'review_costs'
  | 'low_quality_listing'

export interface ClassificationResult {
  type:                    RecommendationType
  reason:                  string                   // codigo curto interno
  strategy:                'conservative' | 'competitive' | 'aggressive' | null
  price:                   number | null
}

export type RecommendationStatus =
  | 'pending'
  | 'approved'
  | 'edited'
  | 'rejected'
  | 'auto_approved'
  | 'applied'
  | 'expired'

export interface CampaignsConfig {
  min_acceptable_margin_pct:    number
  target_margin_pct:            number
  clearance_min_margin_pct:     number
  safety_stock_days:            number
  high_stock_threshold_days:    number
  min_stock_to_participate:     number
  quality_gate_enabled:         boolean
  quality_gate_min_score:       number
  default_packaging_cost:       number
  default_operational_cost_pct: number
  ai_daily_cap_usd:             number
  ai_alert_at_pct:              number
  ai_reasoning_enabled:         boolean
  auto_suggest_on_new_candidate:boolean
  daily_analysis_enabled:       boolean
  auto_approve_enabled:         boolean
  auto_approve_score_above:     number
}
