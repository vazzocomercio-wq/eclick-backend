/**
 * Tipos compartilhados do F10 ML Listing Center.
 * Espelham o schema definido em supabase/migrations/20260537_ml_listing_center_foundation.sql.
 */

export type TaskType =
  | 'OUT_OF_STOCK'
  | 'INACTIVE_PAUSED'
  | 'QUALITY_LOW'
  | 'QUALITY_INCOMPLETE'
  | 'PRICE_HIGH'
  | 'PRICE_AUTOMATION_AVAILABLE'
  | 'FISCAL_DATA_MISSING'
  | 'PROMOTION_AVAILABLE'
  | 'PROMOTION_HIGH_OPPORTUNITY'
  | 'DROPSHIP_PARTNER_OUT_OF_STOCK'
  | 'CATALOG_ELIGIBLE'
  | 'LOSING_BUY_BOX'
  | 'INACTIVE_BY_POLICY'
  | 'WRONG_DIMENSIONS'
  | 'SHIPPING_COST_CHANGED'
  | 'BUYER_EXPERIENCE_ISSUE'
  | 'FULL_ELIGIBLE'

export type TaskSource =
  | 'aggregated_quality'
  | 'aggregated_campaign'
  | 'aggregated_dropship'
  | 'scanner_stock'
  | 'scanner_status'
  | 'scanner_pricing'
  | 'scanner_automation'
  | 'scanner_catalog'
  | 'scanner_fiscal'
  | 'scanner_dimensions'
  | 'scanner_shipping'
  | 'scanner_experience'
  | 'manual'

export type TaskSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type TaskStatus =
  | 'open'
  | 'snoozed'
  | 'in_progress'
  | 'resolved_auto'
  | 'resolved_manual'
  | 'dismissed'
  | 'expired'

export type ImpactArea = 'exposure' | 'margin' | 'sales' | 'reputation' | 'compliance'

export type ScanType =
  | 'full'
  | 'aggregation_only'
  | 'scanner_stock'
  | 'scanner_status'
  | 'scanner_pricing'
  | 'scanner_automation'
  | 'scanner_catalog'
  | 'scanner_fiscal'
  | 'scanner_dimensions'
  | 'scanner_shipping'
  | 'scanner_experience'

export interface ListingTask {
  id: string
  organization_id: string
  seller_id: number
  ml_item_id: string
  ml_user_product_id: string | null
  product_id: string | null
  task_type: TaskType
  task_title: string
  task_description: string | null
  source: TaskSource
  source_record_id: string | null
  source_table: string | null
  severity: TaskSeverity
  priority_score: number | null
  impact_area: ImpactArea[]
  estimated_impact_brl: number | null
  estimated_impact_description: string | null
  current_value: Record<string, unknown>
  suggested_value: Record<string, unknown>
  suggested_action: string | null
  deeplink_url: string | null
  deeplink_module: string | null
  status: TaskStatus
  snoozed_until: string | null
  resolution_notes: string | null
  resolved_by: string | null
  resolved_at: string | null
  first_detected_at: string
  last_seen_at: string
  detection_count: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AggregatedSignal {
  organization_id: string
  seller_id: number
  ml_item_id: string
  product_id: string | null
  source: TaskSource
  source_record_id: string
  source_table: string
  task_type: TaskType
  severity: TaskSeverity
  quality_score: number | null
  missing_attrs_count: number | null
  has_exposure_penalty: boolean
  source_updated_at: string
}

export interface ScanResult {
  scan_type: ScanType
  items_scanned: number
  tasks_created: number
  tasks_updated: number
  tasks_resolved_auto: number
  api_calls_count: number
  errors_count: number
  duration_seconds: number
  status: 'completed' | 'partial' | 'failed'
}

export interface ListingSummary {
  total_open_tasks: number
  total_critical: number
  total_high: number
  total_medium: number
  total_low: number
  tasks_by_type: Record<string, number>
  total_estimated_impact_brl: number
  high_impact_tasks_count: number
  last_full_scan_at: string | null
}
