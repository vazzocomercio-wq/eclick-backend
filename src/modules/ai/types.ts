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

// ── Image generation (F5-2) ─────────────────────────────────────────────

// Batch 1.13 — chaves limpas: square (1:1 1080x1080), story (9:16 1080x1920),
// wide (16:9 1920x1080). Formats antigos (square_1080/story_1080x1920/
// feed_1080x1350) ainda podem aparecer em rows existentes do DB; consumers
// que dependem do tipo lidam só com novos.
export type ImageFormat = 'square' | 'story' | 'wide' | 'custom'

export interface GenerateImageInput {
  orgId:           string
  feature:         FeatureKey
  prompt:          string
  /** Quando presente, usa modo "edit" do gpt-image-1 (image-to-image). */
  sourceImageUrl?: string
  format:          ImageFormat
  /** Para format='custom', obrigatório. */
  customSize?:     { width: number; height: number }
  /** Quantidade de variações (1-6). gpt-image-1 não suporta n>1 nativo,
   * faz N chamadas em paralelo. */
  n:               number
  override?:       { provider: Provider; model: string }
}

export interface GenerateImageOutput {
  images:       Array<{ url?: string; b64?: string }>
  provider:     Provider
  model:        string
  costUsd:      number
  latencyMs:    number
  fallbackUsed: false   // imagem não tem fallback nesta sprint
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
