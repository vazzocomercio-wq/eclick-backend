import {
  bandBounds, classifyCounts, countsAtOrBelow, thresholdsFor, worstLevel,
} from './ml-reputation.rules'
import {
  METRIC_KEYS, RISK_ORDER,
  type DataCoverage, type LevelOrUnknown, type MetricKey, type MetricResult, type MetricThresholds,
  type OfficialMetric, type OfficialReputation, type PeriodForecast, type ReputationInput,
  type ReputationLevel, type ReputationResult, type ReputationRuleSet, type RiskLevel, type RiskOrUnknown,
  type RuleSetConfig, type SimulationInput, type WindowCounts,
} from './ml-reputation.types'

/**
 * ReputationEngine — motor PURO (sem banco, sem rede, sem relógio).
 *
 * Recebe contagens já agregadas (janela curta + longa), a regra vigente e
 * devolve tudo que a UI mostra: período aplicado, faixa de cada métrica,
 * margem, quantas ocorrências ainda cabem, quantas vendas diluem, risco
 * preventivo, previsão de troca de janela e comparação com o oficial.
 *
 * Toda decisão de faixa usa o valor REAL (aritmética inteira em
 * classifyCounts). Arredondamento é só na apresentação (frontend).
 */

const DAY_MS = 24 * 60 * 60 * 1000
const FORECAST_HORIZON_DAYS = 14
/** Divergência local × oficial considerada relevante: ≥ 0,5 p.p. E ≥ 25% relativo. */
const DIVERGENCE_ABS_PP = 0.5
const DIVERGENCE_REL     = 0.25

// ── Helpers aritméticos (exportados pra teste) ────────────────────────────

/**
 * Maior k ≥ 0 tal que (afetadas + k) / total × 100 ≤ limite, mantendo o
 * total FIXO. null se total = 0. Se já está acima do limite, 0.
 */
export function remainingOccurrencesStatic(affected: number, total: number, limitPct: number): number | null {
  if (total <= 0) return null
  // k ≤ limite·total/100 − afetadas  → inteiro: k ≤ floor((L·total − afetadas·10000) / 10000), L = limite·100
  const L = Math.round(limitPct * 100)
  const k = Math.floor((L * total - affected * 10_000) / 10_000)
  return Math.max(0, k)
}

/**
 * Maior k ≥ 0 tal que (afetadas + k) / (total + k) × 100 ≤ limite — cada
 * ocorrência nova também é uma venda nova. null se total = 0 ou se o limite
 * é ≥ 100% (nunca estoura).
 */
export function remainingOccurrencesDynamic(affected: number, total: number, limitPct: number): number | null {
  if (total <= 0) return null
  if (limitPct >= 100) return null
  // (a + k)·10000 ≤ L·(t + k)  ⇔  k·(10000 − L) ≤ L·t − a·10000
  const L = Math.round(limitPct * 100)
  const k = Math.floor((L * total - affected * 10_000) / (10_000 - L))
  return Math.max(0, k)
}

/**
 * Menor x ≥ 0 (inteiro) tal que afetadas / (total + x) × 100 ≤ verde.
 * 0 se já está no verde; null se é impossível (verde = 0 com ocorrências).
 */
export function salesToRecoverGreen(affected: number, total: number, greenPct: number): number | null {
  if (affected <= 0) return 0
  if (total > 0 && countsAtOrBelow(affected, total, greenPct)) return 0
  const G = Math.round(greenPct * 100)
  if (G <= 0) return null
  // (t + x)·G ≥ a·10000  →  x ≥ ceil(a·10000 / G) − t
  const needTotal = Math.ceil((affected * 10_000) / G)
  return Math.max(0, needTotal - total)
}

/** Nível de risco a partir da fração consumida da margem da faixa. */
export function riskFromRatio(ratio: number, risk: RuleSetConfig['risk']): RiskLevel {
  if (ratio >= risk.criticalAt)  return 'critical'
  if (ratio >= risk.highAt)      return 'high'
  if (ratio >= risk.attentionAt) return 'attention'
  return 'safe'
}

/** Piso de risco por faixa: amarelo já é atenção, laranja é alto, vermelho é crítico. */
function baseRiskForLevel(level: ReputationLevel): RiskLevel {
  switch (level) {
    case 'green':  return 'safe'
    case 'yellow': return 'attention'
    case 'orange': return 'high'
    default:       return 'critical'
  }
}

export function worstRisk(levels: RiskOrUnknown[]): RiskOrUnknown {
  const known = levels.filter((l): l is RiskLevel => l !== 'unknown')
  if (known.length === 0) return 'unknown'
  return known.reduce((w, l) => (RISK_ORDER.indexOf(l) > RISK_ORDER.indexOf(w) ? l : w), known[0])
}

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b
}

// ── Período ───────────────────────────────────────────────────────────────

/** 68 ou mais vendas concluídas na janela curta → período curto; senão, longo. */
export function decideMeasurementPeriod(completedShort: number, config: RuleSetConfig): number {
  return completedShort >= config.measurement.minimumSalesForShortPeriod
    ? config.measurement.shortPeriodDays
    : config.measurement.longPeriodDays
}

/**
 * Previsão da troca 60 → 365 usando as DATAS reais das vendas que vão sair
 * da janela. Só prevê o que dá pra calcular com segurança: se as próximas
 * saídas (sem vendas novas) derrubam a conta abaixo do mínimo dentro do
 * horizonte, devolve quando. Fora do horizonte → 'stable'.
 */
export function forecastPeriodChange(
  completedShort: number,
  windowExits: string[] | undefined,
  config: RuleSetConfig,
  asOf: Date,
): PeriodForecast | null {
  const min = config.measurement.minimumSalesForShortPeriod
  if (completedShort < min) return null   // já está em 365d; não há "queda" a prever
  if (!windowExits) return null
  const shortMs = config.measurement.shortPeriodDays * DAY_MS
  const horizonEnd = asOf.getTime() + FORECAST_HORIZON_DAYS * DAY_MS
  const exitTimes = windowExits
    .map(iso => new Date(iso).getTime() + shortMs)
    .filter(t => Number.isFinite(t) && t > asOf.getTime() && t <= horizonEnd)
    .sort((a, b) => a - b)

  const exitsNeeded = completedShort - min + 1   // k-ésima saída derruba abaixo do mínimo
  if (exitsNeeded <= exitTimes.length) {
    const dropAtMs = exitTimes[exitsNeeded - 1]
    return {
      kind:           'may_drop_to_long',
      horizonDays:    FORECAST_HORIZON_DAYS,
      exitsInHorizon: exitTimes.length,
      dropAt:         new Date(dropAtMs).toISOString(),
      dropInDays:     Math.max(0, Math.round(((dropAtMs - asOf.getTime()) / DAY_MS) * 10) / 10),
    }
  }
  return { kind: 'stable', horizonDays: FORECAST_HORIZON_DAYS, exitsInHorizon: exitTimes.length }
}

// ── Métrica ───────────────────────────────────────────────────────────────

function officialFor(key: MetricKey, official: OfficialReputation | null | undefined): OfficialMetric | null {
  if (!official) return null
  if (key === 'cancellations')      return official.cancellations
  if (key === 'claims')             return official.claims
  return official.delayedHandling
}

export function computeMetric(
  key: MetricKey,
  affected: number,
  total: number,
  t: MetricThresholds,
  risk: RuleSetConfig['risk'],
  official: OfficialMetric | null,
): MetricResult {
  const base: Omit<MetricResult, 'percentage' | 'level' | 'currentLimit' | 'nextLevel' | 'nextLevelAt'
    | 'distancePercentagePoints' | 'remainingOccurrencesStatic' | 'remainingOccurrencesDynamic'
    | 'salesToRecoverGreen' | 'marginUsedRatio' | 'riskLevel' | 'divergence'> = {
    key, affectedSales: affected, totalSales: total,
    greenLimit: t.green, yellowLimit: t.yellow, orangeLimit: t.orange, official,
  }

  if (total <= 0) {
    return {
      ...base,
      percentage: null, level: 'unknown', currentLimit: null, nextLevel: null, nextLevelAt: null,
      distancePercentagePoints: null, remainingOccurrencesStatic: null, remainingOccurrencesDynamic: null,
      salesToRecoverGreen: null, marginUsedRatio: null, riskLevel: 'unknown', divergence: null,
    }
  }

  const percentage = (affected / total) * 100
  const level = classifyCounts(affected, total, t)
  const { lower, upper, next } = bandBounds(level, t)

  let marginUsedRatio: number | null = null
  let riskLevel: RiskLevel = baseRiskForLevel(level)
  if (upper != null) {
    const width = upper - lower
    marginUsedRatio = width > 0 ? Math.min(1, Math.max(0, (percentage - lower) / width)) : 1
    riskLevel = maxRisk(riskLevel, riskFromRatio(marginUsedRatio, risk))
  } else {
    marginUsedRatio = 1
  }

  let divergence: MetricResult['divergence'] = null
  if (official?.percentage != null) {
    const delta = percentage - official.percentage
    const rel = official.percentage > 0 ? Math.abs(delta) / official.percentage : (Math.abs(delta) > 0 ? 1 : 0)
    divergence = {
      deltaPercentagePoints: delta,
      significant: Math.abs(delta) >= DIVERGENCE_ABS_PP && rel >= DIVERGENCE_REL,
    }
  }

  return {
    ...base,
    percentage,
    level,
    currentLimit: upper,
    nextLevel:    next,
    nextLevelAt:  upper,
    distancePercentagePoints:    upper != null ? upper - percentage : null,
    remainingOccurrencesStatic:  upper != null ? remainingOccurrencesStatic(affected, total, upper)  : null,
    remainingOccurrencesDynamic: upper != null ? remainingOccurrencesDynamic(affected, total, upper) : null,
    salesToRecoverGreen:         salesToRecoverGreen(affected, total, t.green),
    marginUsedRatio,
    riskLevel,
    divergence,
  }
}

// ── Motor principal ───────────────────────────────────────────────────────

function affectedFor(key: MetricKey, w: WindowCounts): number {
  if (key === 'cancellations')      return w.sellerCancelled
  if (key === 'claims')             return w.claims
  return w.shippingIssues
}

function buildWarnings(input: ReputationInput, periodDays: number): string[] {
  const w: string[] = []
  const cov = input.coverage
  if (!cov) return w
  const asOf = input.asOf.getTime()
  const windowStart = asOf - periodDays * DAY_MS
  if (cov.oldestSaleAt && new Date(cov.oldestSaleAt).getTime() > windowStart + DAY_MS) {
    w.push('orders_partial_coverage')
  }
  if (!cov.claimsSince) w.push('claims_no_data')
  else if (new Date(cov.claimsSince).getTime() > windowStart + DAY_MS) w.push('claims_partial_coverage')
  if (!cov.delaysSince) w.push('shipping_no_data')
  else if (new Date(cov.delaysSince).getTime() > windowStart + DAY_MS) w.push('shipping_partial_coverage')
  if (cov.cancelledTotal > 0 && cov.cancelledWithDetail < cov.cancelledTotal) w.push('cancel_detail_partial')
  return w
}

export function computeReputation(input: ReputationInput, ruleSet: ReputationRuleSet, calculatedAt: Date = input.asOf): ReputationResult {
  const cfg = ruleSet.config
  const periodDays = decideMeasurementPeriod(input.short.completed, cfg)
  const window = periodDays === cfg.measurement.shortPeriodDays ? input.short : input.long

  const metrics = {} as ReputationResult['metrics']
  for (const key of METRIC_KEYS) {
    metrics[key] = computeMetric(
      key,
      affectedFor(key, window),
      window.counted,
      thresholdsFor(cfg, key, periodDays),
      cfg.risk,
      officialFor(key, input.official),
    )
  }

  const overallLevel: LevelOrUnknown = worstLevel(METRIC_KEYS.map(k => metrics[k].level))
  const riskLevel = worstRisk(METRIC_KEYS.map(k => metrics[k].riskLevel))

  return {
    accountId:    input.accountId,
    orgId:        input.orgId,
    calculatedAt: calculatedAt.toISOString(),
    dataAsOf:     input.asOf.toISOString(),
    ruleSet: { name: ruleSet.name, effectiveFrom: ruleSet.effectiveFrom, effectiveUntil: ruleSet.effectiveUntil },
    measurementPeriod:        periodDays,
    shortPeriodDays:          cfg.measurement.shortPeriodDays,
    longPeriodDays:           cfg.measurement.longPeriodDays,
    salesLast60Days:          input.short.completed,
    salesLast365Days:         input.long.completed,
    salesConsidered:          window.counted,
    nextMeasurementThreshold: cfg.measurement.minimumSalesForShortPeriod,
    salesUntilShortPeriod:    Math.max(0, cfg.measurement.minimumSalesForShortPeriod - input.short.completed),
    periodForecast:           forecastPeriodChange(input.short.completed, input.windowExits, cfg, input.asOf),
    metrics,
    overallLevel,
    riskLevel,
    official: input.official ?? null,
    coverage: input.coverage ?? null,
    warnings: buildWarnings(input, periodDays),
  }
}

// ── Simulação ("e se…") — só visual, não grava nada ──────────────────────

function applyToWindow(w: WindowCounts, sim: SimulationInput): WindowCounts {
  const extra = sim.extraOccurrences ?? {}
  const addSales = sim.occurrencesAddSales ?? true
  const c = Math.max(0, Math.floor(extra.cancellations      ?? 0))
  const s = Math.max(0, Math.floor(extra.incorrectShipments ?? 0))
  const q = Math.max(0, Math.floor(extra.claims             ?? 0))
  const newSales = Math.max(0, Math.floor(sim.extraSales ?? 0))
  // Cada ocorrência nova, se também é venda nova, entra no denominador.
  // Cancelamento é venda cancelada (não conta como concluída); atraso e
  // reclamação acontecem em vendas concluídas.
  const occurrenceSales = addSales ? c + s + q : 0
  return {
    completed:       w.completed + newSales + (addSales ? s + q : 0),
    counted:         w.counted + newSales + occurrenceSales,
    sellerCancelled: w.sellerCancelled + c,
    claims:          w.claims + q,
    shippingIssues:  w.shippingIssues + s,
  }
}

export function simulateReputation(input: ReputationInput, ruleSet: ReputationRuleSet, sim: SimulationInput): ReputationResult {
  const simulated: ReputationInput = {
    ...input,
    short: applyToWindow(input.short, sim),
    long:  applyToWindow(input.long, sim),
    // Previsão e oficial não fazem sentido num cenário hipotético.
    windowExits: undefined,
    official:    null,
  }
  return computeReputation(simulated, ruleSet, input.asOf)
}

// ── Conversão do oficial (fração 0-1 → p.p.) ──────────────────────────────

export interface OfficialCurrentRow {
  level_id?:               string | null
  power_seller_status?:    string | null
  claims_rate?:            number | string | null
  cancellations_rate?:     number | string | null
  delayed_handling_rate?:  number | string | null
  claims_count?:           number | null
  cancellations_count?:    number | null
  delayed_handling_count?: number | null
  completed_transactions?: number | null
  total_transactions?:     number | null
  last_synced_at?:         string | null
  claims_period?:          string | null
  cancellations_period?:   string | null
  delayed_period?:         string | null
}

const toPp = (v: number | string | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? n * 100 : null
}

export function officialFromRow(row: OfficialCurrentRow | null | undefined): OfficialReputation | null {
  if (!row) return null
  return {
    levelId:           row.level_id ?? null,
    powerSellerStatus: row.power_seller_status ?? null,
    cancellations:     { percentage: toPp(row.cancellations_rate),    count: row.cancellations_count    ?? null, period: row.cancellations_period ?? null },
    claims:            { percentage: toPp(row.claims_rate),           count: row.claims_count           ?? null, period: row.claims_period ?? null },
    delayedHandling:   { percentage: toPp(row.delayed_handling_rate), count: row.delayed_handling_count ?? null, period: row.delayed_period ?? null },
    completedTransactions: row.completed_transactions ?? null,
    totalTransactions:     row.total_transactions ?? null,
    syncedAt:          row.last_synced_at ?? null,
  }
}

export type { DataCoverage }
