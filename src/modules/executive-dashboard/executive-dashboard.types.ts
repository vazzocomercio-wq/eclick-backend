/**
 * F11 ML Executive Dashboard — types compartilhados.
 *
 * Reflete o schema de `ml_dashboard_summary` (Sprint 1 — migration 20260542)
 * com fields E2/E3/E4 nullable (preenchidos pelas próximas camadas).
 */

export type DashboardRefreshType =
  | 'full'
  | 'aggregation'
  | 'reputation'
  | 'logistics'
  | 'visits'
  | 'sales'

export type DashboardRefreshStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'partial'

/**
 * Snapshot consolidado de 1 (org, seller). Mesmo shape que o cache em
 * `ml_dashboard_summary`. Campos null = ainda não cobertos por uma camada
 * (E2/E3/E4) e o frontend mostra "Sem dado · sync em Xm".
 */
export interface DashboardSnapshot {
  organization_id:                    string
  seller_id:                          number

  // KPIs gerais (E1)
  total_active_listings:              number
  total_paused_listings:              number
  total_inactive_listings:            number
  total_out_of_stock:                 number

  // Vendas últimos 7d (E1)
  sales_7d_count:                     number
  sales_7d_units:                     number
  sales_7d_gmv:                       number
  sales_7d_avg_ticket:                number | null
  sales_7d_change_pct:                number | null

  // Hoje (E1)
  sales_today_count:                  number
  sales_today_gmv:                    number
  shipments_to_dispatch_today:        number   // E3 — null no MVP
  shipments_late:                     number   // E3 — null no MVP

  // Perguntas e pós-venda (cobertura gradual)
  questions_unanswered:               number
  questions_avg_response_hours:       number | null
  questions_critical:                 number
  unread_messages:                    number
  open_claims:                        number
  open_returns:                       number
  open_mediations:                    number

  // F7 Quality Center (E1)
  listings_quality_low:               number
  listings_quality_basic:             number
  listings_with_penalty:              number
  listings_incomplete_specs:          number

  // Pricing / F10 (cobertura gradual)
  listings_price_high:                number
  pricing_automation_eligible:        number
  pricing_automation_active:          number
  pricing_automation_paused:          number

  // F8 Campaign Center (E1)
  active_campaigns:                   number
  campaigns_ending_today:             number
  campaigns_ending_this_week:         number
  campaign_recommendations_pending:   number
  campaign_high_opportunities:        number

  // F9 Dropship (cobertura gradual)
  dropship_pending_oc:                number
  dropship_partner_out_of_stock:      number
  dropship_open_returns:              number
  dropship_payable_next_7d:           number

  // E2 Reputação (null até a camada entrar)
  reputation_level_id:                string | null
  reputation_power_seller_status:     string | null
  reputation_complaints_pct:          number | null
  reputation_cancellations_pct:       number | null
  reputation_late_shipments_pct:      number | null
  reputation_color:                   string | null

  // E4 Visitas (null até a camada entrar)
  visits_7d:                          number | null
  visits_7d_change_pct:               number | null
  conversion_rate_pct:                number | null

  // E3 Logística (null até a camada entrar)
  flex_active_listings:               number
  full_active_listings:               number
  full_storage_used_pct:              number | null

  // F10 high-impact (E1)
  high_impact_recommendations_count:  number
  high_impact_total_estimated_brl:    number

  // Sync metadata
  last_refresh_at:                    string
  next_refresh_at:                    string | null
  refresh_duration_ms:                number | null

  // Label da conta (vem de ml_connections.nickname — útil pro multi-conta selector)
  nickname:                           string | null
}

export interface RefreshResult {
  org_id:           string
  seller_id:        number
  refresh_type:     DashboardRefreshType
  duration_ms:      number
  api_calls_count:  number
}

export interface RefreshLog {
  id:               string
  organization_id:  string
  seller_id:        number | null
  refresh_type:     DashboardRefreshType
  status:           DashboardRefreshStatus
  api_calls_count:  number
  records_updated:  number
  error_message:    string | null
  duration_ms:      number | null
  started_at:       string
  completed_at:     string | null
}
