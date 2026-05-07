// Shapes da API ML pra reputação/claims que consumimos. Cobre só o subset
// necessário pra MVP 2.

export interface MlClaimApiResponse {
  id:               number
  resource_id?:     number
  type?:            string
  stage?:           string
  status?:          string
  reason_id?:       string
  reason?:          { name?: string }
  date_created:     string
  last_updated?:    string
  resource?:        string
}

export interface MlReputationApiResponse {
  level_id?:               string
  power_seller_status?:    string
  status?:                 string
  transactions?: {
    total?:                number
    completed?:            number
    canceled?:             number
    period?:               string
    ratings?: {
      positive?:           number
      neutral?:            number
      negative?:           number
    }
  }
  metrics?: {
    claims?:               { rate?: number; value?: number; period?: string }
    cancellations?:        { rate?: number; value?: number; period?: string }
    delayed_handling_time?: { rate?: number; value?: number; period?: string }
  }
}

export type ClaimRemovalConfidence = 'low' | 'medium' | 'high'

export interface ClaimRemovalAnalysis {
  isCandidate:            boolean
  confidence:             ClaimRemovalConfidence
  reason:                 string
  suggestedAction:        string
  suggestedRequestText:   string | null
}
