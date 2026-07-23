/** Radar de Encaixe — tipos compartilhados. */

export type HostStatus  = 'ativo' | 'arquivado'
export type PainKind    = 'dor' | 'hipotese'
export type PainStatus  = 'nova' | 'validando' | 'descartada' | 'virou_conceito'

export interface OppHost {
  id:                 string
  organization_id:    string
  platform:           string
  anchor_item_id:     string
  item_ids:           string[]
  catalog_product_id: string | null
  title:              string | null
  brand:              string | null
  thumbnail:          string | null
  url:                string | null
  price_cents:        number | null
  category_name:      string | null
  reviews_total:      number
  reviews_fetched:    number
  rating_average:     number | null
  rating_levels:      Record<string, number> | null
  status:             HostStatus
  source:             string
  notes:              string | null
  reviews_fetched_at: string | null
  mined_at:           string | null
  created_at:         string
  updated_at:         string
}

export interface OppReviewRow {
  id:              string
  organization_id: string
  host_id:         string
  item_id:         string
  external_id:     string
  rate:            number
  title:           string | null
  content:         string | null
  likes:           number
  reviewed_at:     string | null
}

export interface PainQuote {
  review_id: string
  rate:      number
  excerpt:   string
}

export interface OppPain {
  id:              string
  organization_id: string
  host_id:         string
  kind:            PainKind
  label:           string
  description:     string | null
  quote_count:     number
  quotes:          PainQuote[]
  confidence:      number | null
  ai_model:        string | null
  status:          PainStatus
  created_at:      string
  updated_at:      string
}

/** Shape das reviews da API ML (subset). */
export interface MlReview {
  id:              number | string
  rate:            number
  title:           string | null
  content:         string | null
  likes:           number
  date_created?:   string
}

export interface FetchReviewsResult {
  total:    number
  fetched:  number
  inserted: number
  pages:    number
  errors:   string[]
}

export interface MineResult {
  reviews_considered: number
  pains:              number
  dores:              number   // com ≥3 citações
  hipoteses:          number
}
