/** Types do F7 Quality Center IA — Camada 1 (Diagnostico). */

export type MlQualityLevel = 'basic' | 'satisfactory' | 'professional'

/** Shape do item retornado por /catalog_quality/status?include_items=true */
export interface MlAdoptionStatus {
  pi:  { complete: boolean; attributes: string[]; missing_attributes: string[] }
  ft:  { complete: boolean; attributes: string[]; missing_attributes: string[] }
  all: { complete: boolean; attributes: string[]; missing_attributes: string[] }
}

export interface MlCatalogQualityItem {
  item_id:           string
  domain_id:         string
  adoption_status:   MlAdoptionStatus
}

export interface MlCatalogQualityDomain {
  domain_id:                 string
  status:                    { metrics: any; total_items: number; total_items_without_domain: number }
  items:                     MlCatalogQualityItem[]
}

export interface MlCatalogQualityResponse {
  status:    { metrics: any; total_items: number; total_items_without_domain: number }
  domains:   MlCatalogQualityDomain[]
}

/** Snapshot persistido por (org, seller, item) — UPSERT no sync. */
export interface MlQualitySnapshot {
  id:                          string
  organization_id:             string
  seller_id:                   number
  product_id:                  string | null
  ml_item_id:                  string
  ml_user_product_id:          string | null
  ml_domain_id:                string | null
  ml_score:                    number | null
  ml_level:                    MlQualityLevel | null
  pi_complete:                 boolean
  pi_filled_count:             number
  pi_missing_count:            number
  pi_missing_attributes:       string[]
  ft_complete:                 boolean
  ft_filled_count:             number
  ft_missing_count:            number
  ft_missing_attributes:       string[]
  all_complete:                boolean
  all_filled_count:            number
  all_missing_count:           number
  all_missing_attributes:      string[]
  ml_tags:                     string[]
  has_exposure_penalty:        boolean
  penalty_reasons:             string[]
  pending_actions:             any[]
  pending_count:               number
  internal_priority_score:     number | null
  fix_complexity:              'easy' | 'medium' | 'hard' | 'blocked' | null
  estimated_score_after_fix:   number | null
  raw_adoption_status:         MlAdoptionStatus | Record<string, never>
  fetched_at:                  string
  created_at:                  string
  updated_at:                  string
}

export interface MlQualityOrgSummary {
  total_items:                 number
  items_basic:                 number
  items_satisfactory:          number
  items_professional:          number
  items_complete:              number
  items_incomplete:            number
  items_with_penalty:          number
  avg_score:                   number | null
  median_score:                number | null
  total_pending_actions:       number
  top_critical_domains:        Array<{ domain_id: string; items_incomplete: number; avg_score: number }>
  top_missing_attributes:      Array<{ attribute: string; missing_in_items: number }>
  quick_wins_count:            number
  quick_wins_estimated_gain:   number
  last_sync_at:                string | null
}

export interface MlQualitySyncResult {
  log_id:           string
  items_processed:  number
  items_updated:    number
  items_failed:     number
  api_calls_count:  number
  duration_seconds: number
}
