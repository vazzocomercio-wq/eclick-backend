/** F18 F1.1 — Shopee Algorithm Score.
 *
 *  Decompõe cada anúncio em 4 pilares (relevância 40/performance 30/qualidade
 *  loja 20/preço-marketing 10), retorna score total 0-100 + lista priorizada
 *  de issues acionáveis. Espelha o pattern do ml_listing_seo_scores (F10).
 *
 *  Filosofia: nunca uma nota única — sempre breakdown auditável. Cada pilar
 *  conta uma história diferente (CTR ruim ≠ chat ruim ≠ preço alto).
 */

export type AlgoScorePillar =
  | 'relevance'
  | 'performance'
  | 'seller_quality'
  | 'price_marketing'

export type AlgoScoreSeverity = 'high' | 'medium' | 'low'

/** Issue acionável devolvida com o breakdown. Severity determina ordem
 *  da lista (high primeiro). recommended_action é texto humano direto
 *  pro lojista — sem termo técnico. */
export interface AlgoScoreIssue {
  pillar:              AlgoScorePillar
  code:                string                  // ex: 'short_title', 'low_ctr', 'late_ship'
  severity:            AlgoScoreSeverity
  description:         string                  // o que está errado
  recommended_action:  string                  // o que fazer
  current_value?:      number | string
  target_value?:       number | string
}

/** Métricas da loja (Quality pillar). Snapshot mais recente da loja.
 *  Mesmo valor pra TODOS anúncios da mesma shop_id — Quality é shop-level. */
export interface ShopMetricsInput {
  /** % de chats respondidos. 0-1. */
  chat_response_rate?:     number | null
  /** Tempo médio de resposta em minutos. */
  chat_response_time_min?: number | null
  /** Dias médios entre confirmação e envio. */
  prep_time_days?:         number | null
  /** % de envios atrasados. 0-1. */
  late_ship_rate?:         number | null
  /** % de devoluções+reembolsos. 0-1. */
  return_refund_rate?:     number | null
  /** Nota da loja 0-5. */
  rating?:                 number | null
  /** Pontos de punição acumulados (Shopee BR: 6+ = ameaça grave). */
  penalty_points?:         number | null
}

/** Input pra computar o score. Tudo opcional — campos ausentes dão nota
 *  parcial (não zera o pilar). Permite cálculo incremental conforme dados
 *  fluem do sync (alguns vêm do listing detail, outros do shop_metrics). */
export interface AlgoScoreInput {
  // Identificação
  shop_id:        number
  item_id:        number
  product_id?:    string | null              // FK opcional pra hub public.products

  // Pillar 1 — Relevância
  title?:                string | null
  description?:          string | null
  image_count?:          number | null
  image_min_dimension?:  number | null       // menor lado da menor imagem (px)
  attrs_filled?:         number | null
  attrs_mandatory_total?: number | null

  // Pillar 2 — Performance
  sales_7d?:           number | null
  sales_30d?:          number | null
  views_30d?:          number | null
  ctr?:                number | null         // 0-1 (cliques/impressões)
  conversion?:         number | null         // 0-1 (pedidos/cliques)
  created_at?:         Date | string | null  // pra new-product boost (< 90d)

  // Pillar 3 — Qualidade de loja
  shop_metrics?:       ShopMetricsInput | null

  // Pillar 4 — Preço + marketing
  price?:              number | null
  market_median_price?: number | null
  has_voucher?:        boolean | null
  has_flash_sale?:     boolean | null
  has_ads?:            boolean | null
}

/** Resultado do compute. Score total + breakdown por pilar (0-100) + issues
 *  priorizadas. Persistido em shopee.algo_score_breakdown sem perda. */
export interface AlgoScoreBreakdown {
  /** Score total 0-100, arredondado. Fórmula: 0.40·R + 0.30·P + 0.20·Q + 0.10·PM. */
  score:    number
  pillars:  {
    relevance:        number
    performance:      number
    seller_quality:   number
    price_marketing:  number
  }
  /** Lista priorizada (high → medium → low). UI mostra os top 5. */
  issues:   AlgoScoreIssue[]
}

/** Resultado interno de cada sub-scorer — score + issues do pilar. */
export interface PillarResult {
  score:  number
  issues: AlgoScoreIssue[]
}

/** Pesos por pilar. Cravados no service — mudança requer mudança de modelo. */
export const PILLAR_WEIGHTS = {
  relevance:        0.40,
  performance:      0.30,
  seller_quality:   0.20,
  price_marketing:  0.10,
} as const
