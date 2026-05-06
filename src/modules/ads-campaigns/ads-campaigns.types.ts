/** Onda 3 / S4 — tipos do Ads Hub. */

export type AdsPlatform = 'meta' | 'google' | 'tiktok' | 'mercado_livre_ads'

export type AdsObjective =
  | 'traffic'
  | 'conversions'
  | 'engagement'
  | 'awareness'
  | 'catalog_sales'
  | 'leads'

export type AdsStatus =
  | 'draft'
  | 'ready'
  | 'publishing'
  | 'active'
  | 'paused'
  | 'completed'
  | 'error'
  | 'archived'

export interface AdCopy {
  variant:       string         // 'A' | 'B' | 'C'
  headline:      string
  primary_text:  string
  description?:  string
  cta:           string         // SHOP_NOW, LEARN_MORE, etc.
  angle?:        string         // ângulo psicológico do copy
  image_url?:    string
  creative_image_id?: string
}

export interface AdsCampaign {
  id:                  string
  organization_id:     string
  product_id:          string | null
  user_id:             string
  platform:            AdsPlatform
  name:                string
  objective:           AdsObjective
  targeting:           Record<string, unknown>
  budget_daily_brl:    number
  budget_total_brl:    number | null
  duration_days:       number
  bid_strategy:        string
  ad_copies:           AdCopy[]
  destination_url:     string | null
  utm_params:          Record<string, string>
  status:              AdsStatus
  external_campaign_id: string | null
  external_adset_id:    string | null
  external_ad_ids:      string[]
  published_at:        string | null
  metrics:             Record<string, unknown>
  generation_metadata: Record<string, unknown>
  created_at:          string
  updated_at:          string
}
