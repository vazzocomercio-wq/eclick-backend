// Tipos compartilhados pela Sprint P2 (signals + notifications).

export type SignalType   = 'decrease_price' | 'increase_price' | 'do_not_touch' | 'review_needed' | 'low_confidence'
export type SignalStatus = 'active' | 'actioned' | 'expired' | 'auto_applied'
export type Severity     = 'low' | 'medium' | 'high' | 'critical'
export type NotifStatus  = 'pending' | 'sent' | 'failed' | 'skipped' | 'disabled'

export interface PricingSignal {
  id?:                  string
  organization_id:      string
  product_id:           string | null
  listing_id:           string | null
  channel:              string
  signal_type:          SignalType
  trigger_id:           string
  severity:             Severity
  title:                string
  description:          string | null
  current_price:        number | null
  suggested_price:      number | null
  current_margin_pct:   number | null
  min_safe_price:       number | null
  signal_data:          Record<string, unknown>
  confidence_score:     number
  confidence_breakdown: Record<string, number>
  status?:              SignalStatus
  notification_status?: NotifStatus
  expires_at?:          string
  created_at?:          string
}

/** Snapshot agregado de 1 produto. Cada bloco é best-effort —
 * se a fonte não tem dados, o bloco vira null e a confiança é
 * penalizada. data_sources rastreia o que conseguimos ler. */
export interface ProductSnapshot {
  product: {
    id:             string
    name:           string | null
    sku:            string | null
    listing_id:     string | null
    current_price:  number | null
    cost_price:     number | null
  }
  abc_curve:        'A' | 'B' | 'C' | null
  segment:          string | null

  stock: {
    quantity:       number | null
    velocity:       number | null   // unidades/dia (sales_30d / 30)
    coverage_days:  number | null
  }
  sales: {
    d7:                   number
    d30:                  number
    d90:                  number
    revenue_30d:          number
    trend_7d_vs_30d_pct:  number | null
    last_sale_at:         string | null
    days_since_last_sale: number | null
  }
  ads: {
    ctr_7d:              number | null
    roas_7d:             number | null
    acos_7d:             number | null
    in_active_campaign:  boolean
  }
  competitors: {
    prices:               number[]
    min_price:            number | null
    position_in_channel:  number | null
    main_competitor_oos:  boolean
  }
  incoming: {
    units:           number
    arrival_days:    number | null
    has_incoming:    boolean
  }
  history: {
    last_change_at:        string | null
    days_since_last_change: number | null
  }
  seasonal: {
    period:             { name: string; pricing_adjustment_pct: number | null; margin_override_pct: number | null } | null
    adjustment_pct:     number | null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config_for_org:    any  // PricingConfig — passado pra detector

  data_sources: {
    has_cost:           boolean
    has_sales_history:  boolean
    has_competitor:     boolean
    has_ads:            boolean
    has_stock:          boolean
  }
  is_new_product:      boolean   // < 30 dias
  data_age_hours:      number    // máximo entre os timestamps relevantes
  confidence_score:    number
  confidence_breakdown: Record<string, number>
}

export interface NotificationSettings {
  id:                   string
  organization_id:      string
  whatsapp_enabled:     boolean
  whatsapp_phone:       string | null
  notify_severities:    Severity[]
  notify_signal_types:  SignalType[]
  quiet_hours_start:    string | null
  quiet_hours_end:      string | null
  notify_weekends:      boolean
  group_notifications:  boolean
  group_window_minutes: number
  max_per_hour:         number
  max_per_day:          number
  created_at:           string
  updated_at:           string
}
