/** Onda 4 / A1 — tipos do Pricing AI. */

export type PriceDirection = 'increase' | 'decrease' | 'maintain'

export type PricingSuggestionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'expired'
  | 'auto_applied'

export interface PricingScenario {
  price:                 number
  expected_margin:       number
  expected_sales_change: string
}

export interface PricingFactors {
  cost_price?:                 number | null
  current_margin_pct?:         number | null
  suggested_margin_pct?:       number | null
  competitor_avg_price?:       number | null
  competitor_min_price?:       number | null
  competitor_max_price?:       number | null
  stock_level?:                'low' | 'normal' | 'high' | 'critical'
  stock_days_remaining?:       number | null
  sales_velocity_30d?:         number | null
  sales_velocity_trend?:       'rising' | 'stable' | 'declining' | 'unknown'
  abc_class?:                  'A' | 'B' | 'C' | null
  seasonality_factor?:         number | null
  marketplace_commission_pct?: number | null
  shipping_avg_cost?:          number | null
  ads_cpa?:                    number | null
  conversion_rate?:            number | null
}

export interface PricingAnalysis {
  factors:    PricingFactors
  reasoning:  string
  confidence: number  // 0-1
  scenarios:  {
    conservative: PricingScenario
    optimal:      PricingScenario
    aggressive:   PricingScenario
  }
}

export interface RuleApplied {
  rule:    string
  applied: boolean
  impact:  string
}

export interface PricingSuggestion {
  id:                 string
  organization_id:    string
  product_id:         string
  current_price:      number
  suggested_price:    number
  price_change_pct:   number | null
  price_direction:    PriceDirection | null
  analysis:           PricingAnalysis | Record<string, unknown>
  rules_applied:      RuleApplied[]
  status:             PricingSuggestionStatus
  applied_at:         string | null
  applied_price:      number | null
  rejection_reason:   string | null
  expires_at:         string
  created_at:         string
}

export type AnalysisFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'manual'

export interface PricingRules {
  id:                        string
  organization_id:           string
  min_margin_pct:            number
  max_discount_pct:          number
  price_rounding:            'x.90' | 'x.99' | 'x.00' | 'none'
  auto_apply_enabled:        boolean
  auto_apply_max_change_pct: number
  rules:                     Array<Record<string, unknown>>
  analysis_frequency:        AnalysisFrequency
  last_analysis_at:          string | null
  next_analysis_at:          string | null
}
