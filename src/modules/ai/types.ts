import { FeatureKey, Provider } from './defaults'

export interface GenerateTextInput {
  orgId:         string
  feature:       FeatureKey
  systemPrompt?: string
  userPrompt:    string
  maxTokens?:    number
  temperature?:  number
  jsonMode?:     boolean
  /** Force a specific provider/model (skips ai_feature_settings + registry). */
  override?:     { provider: Provider; model: string }
}

export interface GenerateTextOutput {
  text:         string
  provider:     Provider
  model:        string
  inputTokens:  number
  outputTokens: number
  costUsd:      number
  latencyMs:    number
  fallbackUsed: boolean
}

/** ai_feature_settings row shape (matches DB schema). */
export interface FeatureSettingRow {
  id:                string
  organization_id:   string
  feature_key:       FeatureKey
  primary_provider:  Provider
  primary_model:     string
  fallback_provider: Provider | null
  fallback_model:    string | null
  enabled:           boolean
  created_at:        string
  updated_at:        string
}

/** Merged view: settings + isDefault flag. Used by GET /ai/settings. */
export interface MergedFeatureSetting {
  feature_key:       FeatureKey
  label:             string
  description:       string
  primary_provider:  Provider
  primary_model:     string
  fallback_provider: Provider | null
  fallback_model:    string | null
  enabled:           boolean
  isDefault:         boolean
}
