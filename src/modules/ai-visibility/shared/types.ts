// Tipos compartilhados do módulo AI Visibility OS (GEO).

/** Motores de IA que auditamos / monitoramos. */
export type AiPlatform =
  | 'chatgpt'
  | 'perplexity'
  | 'gemini'
  | 'google_ai_overview'
  | 'copilot'

export const AI_PLATFORMS: AiPlatform[] = [
  'chatgpt',
  'perplexity',
  'gemini',
  'google_ai_overview',
  'copilot',
]

/** Estado de um job de auditoria. */
export type AuditStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Uma dimensão da rubrica de pontuação (geo_score). */
export interface ScoreDimension {
  dimension:   string
  label:       string
  weight:      number
  description?: string
}
