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

/** Estado de um job de auditoria (fila via DB, sem Redis). */
export type AuditStatus = 'pending' | 'processing' | 'retry' | 'completed' | 'failed'

/** Uma dimensão da rubrica de pontuação (geo_score). */
export interface ScoreDimension {
  dimension:   string
  label:       string
  weight:      number
  description?: string
}

/** Marketplace de origem da URL auditada (coluna ai_audit_jobs.platform). */
export type MarketplacePlatform = 'mercadolivre' | 'shopee' | 'amazon' | 'generic'

/** Dados estruturados extraídos de um listing pelo ListingScraperService. */
export interface ScrapedListing {
  url:           string
  platform:      MarketplacePlatform
  listingId:     string | null
  title:         string | null
  description:   string | null
  attributes:    Array<{ name: string; value: string }>
  price:         number | null
  images:        string[]
  reviews_count: number | null
  rating:        number | null
  category:      string | null
  /** Trecho do HTML bruto (capado) — só pra generic/fallback. */
  rawHtmlSnippet?: string | null
}

/** As 8 dimensões pontuáveis do GEO Score. */
export type GeoDimensionName =
  | 'title_geo'
  | 'description_depth'
  | 'entity_coverage'
  | 'semantic_density'
  | 'structured_data'
  | 'review_architecture'
  | 'faq_presence'
  | 'crawler_access'

/** Resultado de uma dimensão pontuada (0-10). */
export interface GeoDimensionResult {
  name:      GeoDimensionName
  score:     number   // 0-10
  weight:    number
  reasoning: string
  evidence:  string
}

/** Saída do GeoScoreCalculatorService. */
export interface GeoScoreResult {
  geoScore:   number             // 0-100 (normalizado pelos pesos)
  dimensions: GeoDimensionResult[]
  costUsd:    number             // soma das chamadas LLM
}

/** Uma recomendação acionável (fix) gerada pra uma dimensão fraca. */
export interface GeoRecommendation {
  dimension:        GeoDimensionName
  severity:         'high' | 'medium' | 'low'
  title:            string
  description:      string
  example_before:   string
  example_after:    string
  estimated_impact: string        // ex: "+8 pontos se aplicar"
}
