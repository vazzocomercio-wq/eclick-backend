/**
 * Tipos do Módulo de Reputação Mercado Livre.
 *
 * Dois mundos, sempre separados na UI e no banco:
 *   • OFICIAL  — o que a API do ML devolve em /users/{id} → seller_reputation
 *                (sync já existente em executive-reputation.service.ts).
 *   • LOCAL    — o que o e-Click calcula a partir dos pedidos, reclamações e
 *                atrasos sincronizados, aplicando um conjunto de regras
 *                VERSIONADO (ml_reputation_rule_sets).
 *
 * Percentuais: em PONTOS PERCENTUAIS (2.5 = 2,5%) em todo o módulo.
 * A API oficial do ML usa fração 0-1 — a conversão acontece UMA vez, ao
 * montar `OfficialReputation`.
 */

export type MetricKey = 'cancellations' | 'incorrectShipments' | 'claims'
export const METRIC_KEYS: readonly MetricKey[] = ['cancellations', 'incorrectShipments', 'claims'] as const

export type ReputationLevel = 'green' | 'yellow' | 'orange' | 'red'
export type LevelOrUnknown  = ReputationLevel | 'unknown'
export const LEVEL_ORDER: readonly ReputationLevel[] = ['green', 'yellow', 'orange', 'red'] as const

/** Classificação preventiva: quanto da margem da faixa atual já foi consumido. */
export type RiskLevel = 'safe' | 'attention' | 'high' | 'critical'
export type RiskOrUnknown = RiskLevel | 'unknown'
export const RISK_ORDER: readonly RiskLevel[] = ['safe', 'attention', 'high', 'critical'] as const

// ── Regras versionadas ────────────────────────────────────────────────────

/** Limites superiores (inclusivos) de cada faixa, em p.p. Vermelho = acima de `orange`. */
export interface MetricThresholds {
  green:  number
  yellow: number
  orange: number
}

export interface RuleSetConfig {
  measurement: {
    shortPeriodDays:            number   // 60
    longPeriodDays:             number   // 365
    minimumSalesForShortPeriod: number   // 68 a partir de 10/09/2026
  }
  /** metrics[metric][periodDays] — chave do período como string ("60" | "365"). */
  metrics: Record<MetricKey, Record<string, MetricThresholds>>
  /** Frações (0-1) da margem da faixa atual que disparam cada nível de risco. */
  risk: {
    attentionAt: number
    highAt:      number
    criticalAt:  number
  }
}

export interface ReputationRuleSet {
  id?:            string
  marketplace:    string
  name:           string
  effectiveFrom:  string | null   // YYYY-MM-DD (data em America/Sao_Paulo)
  effectiveUntil: string | null
  config:         RuleSetConfig
  isBuiltin:      boolean
  notes?:         string | null
}

// ── Entrada do motor ──────────────────────────────────────────────────────

export interface WindowCounts {
  /** Vendas CONCLUÍDAS (pagas e não canceladas) — decide o período (68). */
  completed:       number
  /** Vendas CONSIDERADAS (concluídas + canceladas depois de pagas) — denominador. */
  counted:         number
  sellerCancelled: number
  claims:          number
  shippingIssues:  number
}

export interface DataCoverage {
  /** Pedido mais antigo sincronizado da conta (ISO) — limita a janela de 365d. */
  oldestSaleAt:         string | null
  /** Primeira reclamação sincronizada (ISO) — antes disso não há dado local. */
  claimsSince:          string | null
  /** Primeiro atraso sincronizado (ISO). */
  delaysSince:          string | null
  /** Pedidos cancelados (365d) e quantos têm cancel_detail gravado. */
  cancelledTotal:       number
  cancelledWithDetail:  number
}

export interface OfficialMetric {
  percentage: number | null   // p.p.
  count:      number | null
  period:     string | null   // "60 days" | "365 days" (texto do ML)
}

export interface OfficialReputation {
  levelId:            string | null
  powerSellerStatus:  string | null
  cancellations:      OfficialMetric
  claims:             OfficialMetric
  delayedHandling:    OfficialMetric
  completedTransactions: number | null
  totalTransactions:     number | null
  syncedAt:           string | null
}

export interface ReputationInput {
  accountId:    number
  orgId:        string
  /** Instante usado como "agora" nas janelas móveis. */
  asOf:         Date
  short:        WindowCounts
  long:         WindowCounts
  /** Vendas concluídas que SAEM da janela curta nos próximos dias (ISO, asc). */
  windowExits?: string[]
  coverage?:    DataCoverage | null
  official?:    OfficialReputation | null
}

// ── Saída do motor ────────────────────────────────────────────────────────

export interface MetricResult {
  key:            MetricKey
  affectedSales:  number
  totalSales:     number
  /** Valor REAL (sem arredondar) — a faixa é decidida com ele. null se totalSales = 0. */
  percentage:     number | null
  level:          LevelOrUnknown
  greenLimit:     number
  yellowLimit:    number
  orangeLimit:    number
  /** Limite superior da faixa atual (null no vermelho / desconhecido). */
  currentLimit:   number | null
  /** Próxima faixa (pior) e o limite que a inaugura. */
  nextLevel:      ReputationLevel | null
  nextLevelAt:    number | null
  /** Distância até o limite da faixa atual, em p.p. (null no vermelho). */
  distancePercentagePoints: number | null
  /** Quantas ocorrências cabem antes de mudar de faixa, SEM novas vendas. */
  remainingOccurrencesStatic:  number | null
  /** Idem, considerando que cada ocorrência também é uma venda nova. */
  remainingOccurrencesDynamic: number | null
  /** Vendas sem ocorrência necessárias pra voltar ao verde (0 se já verde). */
  salesToRecoverGreen: number | null
  /** Fração (0-1) da margem da faixa atual já consumida. */
  marginUsedRatio:     number | null
  riskLevel:           RiskOrUnknown
  /** Oficial do ML pra mesma métrica (pode ser null). */
  official:            OfficialMetric | null
  /** Diferença local − oficial em p.p. quando ambos existem. */
  divergence:          { deltaPercentagePoints: number; significant: boolean } | null
}

export interface PeriodForecast {
  /** 'may_drop_to_long' = está em 60d mas pode voltar a 365d; 'stable' = sem troca prevista no horizonte. */
  kind:             'may_drop_to_long' | 'stable'
  horizonDays:      number
  /** Quantas vendas saem da janela no horizonte. */
  exitsInHorizon:   number
  /** Quando a conta cairia abaixo do mínimo, se não vender nada (ISO) — só em may_drop_to_long. */
  dropAt?:          string
  dropInDays?:      number
}

export interface ReputationResult {
  accountId:            number
  orgId:                string
  calculatedAt:         string
  dataAsOf:             string
  ruleSet:              { name: string; effectiveFrom: string | null; effectiveUntil: string | null }
  measurementPeriod:    number           // 60 | 365
  shortPeriodDays:      number
  longPeriodDays:       number
  salesLast60Days:      number           // concluídas na janela curta
  salesLast365Days:     number           // concluídas na janela longa
  salesConsidered:      number           // denominador do período aplicado
  nextMeasurementThreshold: number       // 68
  salesUntilShortPeriod:    number       // max(0, 68 − vendas60d)
  periodForecast:       PeriodForecast | null
  metrics: {
    cancellations:      MetricResult
    incorrectShipments: MetricResult
    claims:             MetricResult
  }
  /** Pior faixa entre as 3 métricas. */
  overallLevel:         LevelOrUnknown
  /** Pior risco entre as 3 métricas. */
  riskLevel:            RiskOrUnknown
  official:             OfficialReputation | null
  coverage:             DataCoverage | null
  /** Avisos de confiabilidade do dado local (cobertura parcial etc.). */
  warnings:             string[]
}

// ── Simulação ─────────────────────────────────────────────────────────────

export interface SimulationInput {
  extraOccurrences?: Partial<Record<MetricKey, number>>
  /** Vendas novas SEM ocorrência. */
  extraSales?: number
  /** Se true (padrão), cada ocorrência extra também conta como venda nova. */
  occurrencesAddSales?: boolean
}
