export interface UpdateHubConfigDto {
  enabled?: boolean
  analyzers_config?: Record<string, unknown>
  digest_config?: Record<string, unknown>
  quiet_hours?: Record<string, unknown>
  cross_intel_enabled?: boolean
  max_alerts_per_manager_per_day?: number
  min_interval_minutes?: number
  learning_enabled?: boolean
  learning_decay_days?: number
}
