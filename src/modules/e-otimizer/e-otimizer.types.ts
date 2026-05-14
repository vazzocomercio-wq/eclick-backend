/**
 * e-Otimizer IA — types compartilhados entre os services.
 *
 * Núcleo do MVP 1: research de categoria ML retornando padrões + keywords +
 * competidores escolhidos, com rastreabilidade total.
 */

// ============================================================
// Raw ML data (subset do que /sites/MLB/search retorna)
// ============================================================

export interface MlSearchHit {
  id:                 string
  title:              string
  price:              number
  original_price:     number | null
  available_quantity: number
  sold_quantity:      number
  condition:          'new' | 'used' | 'not_specified'
  listing_type_id:    string  // free | gold_special | gold_pro
  category_id:        string
  catalog_listing:    boolean
  catalog_product_id: string | null
  health:             number | null   // 0-1, pode vir null
  permalink:          string
  thumbnail:          string
  tags:               string[]
  shipping: {
    free_shipping:    boolean
    logistic_type:    string | null   // 'fulfillment' (= Full), 'xd_drop_off', etc
    mode:             string
  }
  seller: {
    id:                  number
    nickname:            string
    power_seller_status: 'platinum' | 'gold' | 'silver' | null
    car_dealer?:         boolean
    real_estate_agency?: boolean
  }
  attributes: Array<{ id: string; name: string; value_id?: string; value_name?: string }>
  position_in_results: number  // 0-indexed
}

/** Detalhes adicionais de um item via /items/{id} (date_created etc). */
export interface MlItemDetails {
  id:                 string
  date_created:       string   // ISO
  start_time:         string   // ISO
  last_updated:       string   // ISO
  status:             string   // 'active' | 'paused' | ...
}

/** Reputação detalhada via /users/{seller_id}. */
export interface MlSellerReputation {
  level_id:                  string | null  // '5_green', '4_light_green', '3_yellow', '2_orange', '1_red'
  power_seller_status:       'platinum' | 'gold' | 'silver' | null
  metrics: {
    claims_rate?:            number  // 0-1
    delayed_handling_time_rate?: number
    cancellations_rate?:     number
    sales: { period: string; completed: number }
  }
}

// ============================================================
// Competitor scoring
// ============================================================

export interface ScoredCompetitor {
  /** Snapshot mínimo pra rastreabilidade no resultado final. */
  mlb_id:               string
  title:                string
  permalink:            string
  thumbnail:            string
  price:                number
  sold_quantity:        number
  days_on_air:          number | null   // null se /items falhou
  seller_nickname:      string
  power_seller_status:  string | null
  reputation_level:     string | null
  position_in_results:  number
  catalog_listing:      boolean
  free_shipping:        boolean
  is_fulfillment:       boolean         // logistic_type === 'fulfillment'

  /** Scores parciais 0-1 e final. */
  scores: {
    relevance:          number  // 20%
    organic_position:   number  // 20%
    sales_velocity:     number  // 20%
    health_quality:    number  // 15%
    seller_reputation:  number  // 10%
    catalog_full_free:  number  // 10%  (mix: catalog + full + free shipping)
    recency:            number  // 5%
    final:              number  // weighted sum
  }
}

// ============================================================
// Research output — o que o endpoint retorna pro Creative + UI
// ============================================================

export interface KeywordWithSources {
  keyword:      string
  frequency:    number       // qtd de top que contêm essa keyword
  sources_mlb:  string[]     // IDs MLB que contêm — rastreabilidade
  weighted:     number       // freq ajustada por peso de posição (top1=1.0, top20=0.3)
  recommend:    'use' | 'use_if_true' | 'avoid'  // hint pra IA
}

export interface TitlePattern {
  detected_order:    string[]   // ex: ['type','brand','color','material','wattage']
  avg_length:        number
  median_length:     number
  top_first_words:   Array<{ word: string; count: number }>
  examples:          string[]   // 3-5 títulos como exemplo
}

export interface AttributeStats {
  attribute_id:   string
  attribute_name: string
  fill_rate:      number   // 0-1 — % dos top que preenchem
  top_values:     Array<{ value: string; count: number }>
  is_required:    boolean  // da /categories/{id}/attributes
}

export interface CategoryResearch {
  category_ml_id:    string
  category_name:     string
  search_query:      string
  marketplace:       'MLB'    // pra agora só BR

  // Output principal
  top_keywords:      KeywordWithSources[]
  title_pattern:     TitlePattern
  attributes_stats:  AttributeStats[]
  required_attrs_missing_in_user_pov: string[]  // preenchido quando há userItem reference

  // Estatísticas de mercado
  price_stats: {
    median:  number
    avg:     number
    p25:     number
    p75:     number
    min:     number
    max:     number
  }
  listing_type_distribution: {
    free:          number  // %
    gold_special:  number
    gold_pro:      number
  }
  catalog_rate:       number  // %
  fulfillment_rate:   number
  free_shipping_rate: number

  // Competidores escolhidos (rastreabilidade total)
  competitors_analyzed: ScoredCompetitor[]
  candidates_total:     number   // antes de filtrar
  candidates_filtered:  number   // descartados
  candidates_used:      number   // chegaram ao scoring final (top 20)

  // Meta
  generated_at:  string   // ISO
  expires_at:    string   // ISO (24h)
  cache_hit:     boolean
}

// ============================================================
// Scoring weights — single source of truth
// (versão revisada pós-feedback ChatGPT: relevância sobe pra 20%)
// ============================================================

export const SCORING_WEIGHTS = {
  relevance:         0.20,
  organic_position:  0.20,
  sales_velocity:    0.20,
  health_quality:    0.15,
  seller_reputation: 0.10,
  catalog_full_free: 0.10,
  recency:           0.05,
} as const

// Sanity check em runtime
if (Math.abs(Object.values(SCORING_WEIGHTS).reduce((s, w) => s + w, 0) - 1.0) > 0.001) {
  throw new Error('SCORING_WEIGHTS não somam 1.0')
}

/** Peso da posição do top 20 no agregado de keywords. */
export const TOP_POSITION_WEIGHT = (rank0: number): number => {
  if (rank0 < 5)  return 1.0
  if (rank0 < 10) return 0.7
  if (rank0 < 15) return 0.5
  return 0.3
}
