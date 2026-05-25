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

// ── geo-optimizer (Sprint 2) ──────────────────────────────────────────────

export type TitleVariant = 'A' | 'B' | 'C'
export type TitleVariantType = 'transacional' | 'comparativa' | 'informacional'

/** Uma variação de título gerada pelo optimizer. */
export interface TitleVariation {
  variant:            TitleVariant
  type:               TitleVariantType
  title:              string
  reasoning:          string
  target_query:       string
  estimated_geo_lift: number   // pontos estimados no title_geo (0-10)
}

export type OptimizerStatus = 'draft' | 'approved' | 'applied' | 'rolled_back'

// ── ImpactTracker (Dia 14) ────────────────────────────────────────────────

/** Delta de uma métrica universal (antes×depois) no piloto. */
export interface ImpactMetricDelta {
  metric:    'visits' | 'units' | 'revenue'
  before:    number
  after:     number | null   // null = janela ainda aberta
  delta_pct: number | null   // null = N/A (before=0) ou janela aberta
  improved:  boolean         // delta_pct >= THRESHOLD_PCT
}

/** Impacto medido de UM anúncio otimizado. */
export interface ListingImpact {
  listing_id:       string
  optimizer_id:     string | null
  sku:              string | null
  apply_date:       string   // ISO (changed_at do apply)
  window_from:      string   // ISO D+3
  window_to:        string   // ISO D+16
  window_elapsed:   boolean
  days_remaining:   number    // 0 quando elapsed
  geo_score_before: number | null
  metrics:          ImpactMetricDelta[]
  is_win:           boolean    // ≥1 métrica improved
  note:             string | null  // 'window_open' | 'rolled_back' | 'no_product' | null
}

export type ImpactVerdict = 'GO' | 'NO_GO' | 'pending'

/** Relatório agregado do piloto (Risco 2: GEO Score ↔ venda). */
export interface ImpactReport {
  generated_at: string
  total:        number   // anúncios aplicados (com baseline)
  measured:     number   // janela fechada
  pending:      number   // janela aberta
  win_count:    number   // measured com is_win
  threshold:    number   // mínimo de wins p/ GO (3)
  delta_pct:    number   // limite de melhoria por métrica (20)
  verdict:      ImpactVerdict
  listings:     ListingImpact[]
}
