/** Radar de Tendências de Produtos — tipos compartilhados (Fase 1, ML). */

export type TrendPlatform = 'mercado_livre' | 'shopee'
export type BuyDecision   = 'comprar' | 'observar' | 'ignorar'

/** Linha resolvida de produto candidato (best seller) ou keyword em alta. */
export interface TrendProductRow {
  id:              string
  organization_id: string
  platform:        TrendPlatform
  external_id:     string
  kind:            'catalog_product' | 'keyword'
  name:            string
  category_id:     string | null
  category_name:   string | null
  domain_id:       string | null
  price_ref_cents: number | null
  status:          string | null
  thumbnail:       string | null
  url:             string | null
  first_seen_at:   string
  last_seen_at:    string
}

/** Score + decisão de compra (1 por produto). */
export interface TrendScoreRow {
  organization_id:     string
  product_id:          string
  trend_score:         number
  momentum:            number
  volume_score:        number
  breadth_score:       number
  best_seller_rank:    number | null
  rank_delta:          number | null
  buy_decision:        BuyDecision
  margin_estimate_pct: number | null
  confidence:          number
  ai_rationale:        string | null
  components:          Record<string, unknown>
  computed_at:         string
}

/** Card do radar (view v_trends_radar) pra tela. */
export interface RadarCard extends TrendProductRow {
  trend_score:         number | null
  momentum:            number | null
  volume_score:        number | null
  breadth_score:       number | null
  best_seller_rank:    number | null
  rank_delta:          number | null
  buy_decision:        BuyDecision | null
  margin_estimate_pct: number | null
  confidence:          number | null
  ai_rationale:        string | null
  components:          Record<string, unknown> | null
  computed_at:         string | null
  in_watchlist:        boolean
  watch_decision:      string | null
}

export interface TrendsSettings {
  organization_id:   string
  platform:          TrendPlatform
  categories:        string[]
  target_margin_pct: number
  auto_enabled:      boolean
  updated_at:        string
}

/** Resultado de uma rodada de coleta. */
export interface CollectResult {
  searchTrends:  number   // keywords capturadas
  bestSellers:   number   // produtos best-seller capturados/atualizados
  resolved:      number   // produtos resolvidos via /products
  categories:    number   // categorias escaneadas
  errors:        string[]
}
