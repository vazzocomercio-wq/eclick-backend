/** Onda 4 / A3 — tipos das Automações Autônomas. */

export type AutomationTrigger =
  | 'low_stock'             | 'high_stock'
  | 'sales_drop'            | 'sales_spike'
  | 'low_conversion'        | 'high_conversion'
  | 'competitor_price_drop' | 'competitor_out_of_stock'
  | 'low_score'             | 'no_content' | 'no_ads'
  | 'ads_underperforming'   | 'abandoned_carts_spike'
  | 'new_product_ready'     | 'seasonal_opportunity'
  | 'margin_erosion'        | 'review_needed'

export type AutomationSeverity = 'critical' | 'high' | 'medium' | 'low' | 'opportunity'

export type AutomationStatus =
  | 'pending' | 'approved' | 'executing' | 'completed'
  | 'rejected' | 'auto_executed' | 'failed' | 'expired'

export type ProposedActionType =
  | 'adjust_price'
  | 'create_campaign'
  | 'pause_campaign'
  | 'generate_content'
  | 'send_recovery'
  | 'create_collection'
  | 'enrich_products'
  | 'restock_alert'
  | 'create_kit'
  | 'notify_lojista'

export interface ProposedAction {
  type: ProposedActionType
  // Campos variam por tipo
  product_id?:        string
  product_ids?:       string[]
  cart_ids?:          string[]
  campaign_id?:       string
  new_price?:         number
  reason?:            string
  platform?:          string
  budget?:            number
  objective?:         string
  channels?:          string[]
  template?:          string
  current_stock?:     number
  suggested_quantity?: number
  name?:              string
  suggested_categories?: string[]
  suggested_discount_pct?: number
  products?:          Array<{ product_id: string; quantity: number }>
  suggested_price?:   number
  message?:           string
}

export interface StoreAutomationAction {
  id:               string
  organization_id:  string
  trigger_type:     AutomationTrigger
  title:            string
  description:      string
  severity:         AutomationSeverity
  product_ids:      string[]
  affected_count:   number
  proposed_action:  ProposedAction | Record<string, unknown>
  status:           AutomationStatus
  executed_at:      string | null
  execution_result: Record<string, unknown>
  lojista_feedback: 'util' | 'nao_relevante' | 'timing_ruim' | 'acao_errada' | null
  expires_at:       string
  created_at:       string
}

export interface StoreAutomationConfig {
  id:                          string
  organization_id:             string
  enabled:                     boolean
  analysis_frequency:          'hourly' | 'daily' | 'weekly'
  active_triggers:             AutomationTrigger[]
  auto_execute_triggers:       AutomationTrigger[]
  notify_channel:              'dashboard' | 'whatsapp' | 'email' | 'all'
  notify_min_severity:         AutomationSeverity
  max_auto_actions_per_day:    number
  max_price_change_auto_pct:   number
  max_budget_auto_brl:         number
  last_analysis_at:            string | null
}
