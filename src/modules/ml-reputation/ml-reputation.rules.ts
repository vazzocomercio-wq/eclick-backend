import {
  LEVEL_ORDER, METRIC_KEYS,
  type MetricKey, type MetricThresholds, type ReputationLevel, type ReputationRuleSet, type RuleSetConfig,
} from './ml-reputation.types'

/**
 * Regras de reputação ML — versão EMBUTIDA (fallback) + helpers puros.
 *
 * A fonte de verdade em produção é a tabela `ml_reputation_rule_sets`
 * (mesmo shape, seed na migration 20260650). Estas constantes existem pra:
 *   1. o motor funcionar em testes e em ambiente sem banco;
 *   2. o sistema não ficar sem regra se a tabela estiver vazia.
 *
 * ⚠️ Mudou uma regra? Mude no BANCO (ou numa migration nova). Só altere
 * aqui se for pra manter o fallback coerente com o banco.
 */

export const ML_RULE_SET_LEGACY_NAME  = 'ML_REPUTATION_LEGACY'
export const ML_RULE_SET_2026_09_NAME = 'ML_REPUTATION_2026_09'
export const ML_NEW_RULES_EFFECTIVE_FROM = '2026-09-10'

const sameForBoth = (t: MetricThresholds): Record<string, MetricThresholds> => ({ '60': t, '365': t })

const LEGACY_CONFIG: RuleSetConfig = {
  measurement: { shortPeriodDays: 60, longPeriodDays: 365, minimumSalesForShortPeriod: 60 },
  metrics: {
    cancellations:      sameForBoth({ green: 2.5,  yellow: 5.5,  orange: 6.5  }),
    incorrectShipments: sameForBoth({ green: 13.0, yellow: 23.5, orange: 28.5 }),
    claims:             sameForBoth({ green: 2.0,  yellow: 4.5,  orange: 8.0  }),
  },
  risk: { attentionAt: 0.70, highAt: 0.85, criticalAt: 0.95 },
}

const RULES_2026_09_CONFIG: RuleSetConfig = {
  measurement: { shortPeriodDays: 60, longPeriodDays: 365, minimumSalesForShortPeriod: 68 },
  metrics: {
    cancellations: {
      '60':  { green: 1.5,  yellow: 3.5,  orange: 4.0  },
      '365': { green: 2.5,  yellow: 5.5,  orange: 6.5  },
    },
    incorrectShipments: {
      '60':  { green: 10.0, yellow: 18.0, orange: 22.0 },
      '365': { green: 13.0, yellow: 23.5, orange: 28.5 },
    },
    claims: sameForBoth({ green: 2.0, yellow: 4.5, orange: 8.0 }),
  },
  risk: { attentionAt: 0.70, highAt: 0.85, criticalAt: 0.95 },
}

export const BUILTIN_RULE_SETS: readonly ReputationRuleSet[] = [
  {
    marketplace:    'MERCADO_LIVRE',
    name:           ML_RULE_SET_LEGACY_NAME,
    effectiveFrom:  null,
    effectiveUntil: '2026-09-09',
    config:         LEGACY_CONFIG,
    isBuiltin:      true,
    notes:          'Regra anterior a 10/09/2026 (limiar de 60 vendas; faixas iguais nos dois períodos).',
  },
  {
    marketplace:    'MERCADO_LIVRE',
    name:           ML_RULE_SET_2026_09_NAME,
    effectiveFrom:  ML_NEW_RULES_EFFECTIVE_FROM,
    effectiveUntil: null,
    config:         RULES_2026_09_CONFIG,
    isBuiltin:      true,
    notes:          'Nova metodologia válida a partir de 10/09/2026.',
  },
]

// ── Datas ─────────────────────────────────────────────────────────────────

const SP_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Data civil (YYYY-MM-DD) em America/Sao_Paulo — evita virar o dia na hora errada. */
export function toSaoPauloDate(d: Date): string {
  return SP_DATE_FMT.format(d)
}

// ── Resolução de vigência ─────────────────────────────────────────────────

/**
 * Regra vigente numa data (YYYY-MM-DD). Se várias casam, vence a de
 * `effectiveFrom` mais recente. Sem nenhuma: a última cujo início já passou,
 * senão a primeira da lista (nunca devolve undefined se a lista não é vazia).
 */
export function resolveRuleSet(ruleSets: readonly ReputationRuleSet[], date: string): ReputationRuleSet {
  if (ruleSets.length === 0) throw new Error('resolveRuleSet: nenhuma regra disponível')
  const matching = ruleSets.filter(r =>
    (r.effectiveFrom == null || r.effectiveFrom <= date) &&
    (r.effectiveUntil == null || r.effectiveUntil >= date),
  )
  const pick = (list: readonly ReputationRuleSet[]) =>
    [...list].sort((a, b) => (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''))[0]
  if (matching.length > 0) return pick(matching)
  const started = ruleSets.filter(r => r.effectiveFrom == null || r.effectiveFrom <= date)
  if (started.length > 0) return pick(started)
  return [...ruleSets].sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''))[0]
}

/** Próxima regra que ainda NÃO entrou em vigor na data (pra "simulação das regras de 10/09"). */
export function resolveUpcomingRuleSet(ruleSets: readonly ReputationRuleSet[], date: string): ReputationRuleSet | null {
  const future = ruleSets.filter(r => r.effectiveFrom != null && r.effectiveFrom > date)
  if (future.length === 0) return null
  return [...future].sort((a, b) => (a.effectiveFrom ?? '').localeCompare(b.effectiveFrom ?? ''))[0]
}

// ── Validação do config (vindo do banco) ──────────────────────────────────

export function isValidRuleSetConfig(c: unknown): c is RuleSetConfig {
  if (!c || typeof c !== 'object') return false
  const cfg = c as RuleSetConfig
  const m = cfg.measurement
  if (!m || !(m.shortPeriodDays > 0) || !(m.longPeriodDays > m.shortPeriodDays) || !(m.minimumSalesForShortPeriod >= 0)) return false
  if (!cfg.metrics) return false
  for (const key of METRIC_KEYS) {
    const per = cfg.metrics[key]
    if (!per) return false
    for (const p of [String(m.shortPeriodDays), String(m.longPeriodDays)]) {
      const t = per[p]
      if (!t) return false
      if (!(t.green >= 0 && t.yellow >= t.green && t.orange >= t.yellow)) return false
    }
  }
  const r = cfg.risk
  if (!r || !(r.attentionAt > 0 && r.highAt >= r.attentionAt && r.criticalAt >= r.highAt && r.criticalAt <= 1)) return false
  return true
}

// ── Classificação ─────────────────────────────────────────────────────────

export function thresholdsFor(config: RuleSetConfig, metric: MetricKey, periodDays: number): MetricThresholds {
  const per = config.metrics[metric]
  const t = per[String(periodDays)]
  if (!t) throw new Error(`Regra sem limites para ${metric} em ${periodDays} dias`)
  return t
}

/** Tolerância pra comparar percentuais já calculados (1,51% vs 1,5 não pode virar empate). */
const EPS = 1e-9

/**
 * Classifica um PERCENTUAL (p.p.) — usa o valor real, sem arredondar.
 * Limites são inclusivos: 1,50% ≤ 1,5 → verde; 1,51% → amarelo.
 */
export function classifyPercentage(pct: number, t: MetricThresholds): ReputationLevel {
  if (pct <= t.green  + EPS) return 'green'
  if (pct <= t.yellow + EPS) return 'yellow'
  if (pct <= t.orange + EPS) return 'orange'
  return 'red'
}

/**
 * Classifica por CONTAGEM com aritmética inteira — sem erro de ponto
 * flutuante: afetadas/total*100 ≤ limite  ⇔  afetadas·10000 ≤ limite·100·total
 * (limites têm no máximo 2 casas decimais).
 */
export function countsAtOrBelow(affected: number, total: number, limitPct: number): boolean {
  return affected * 10_000 <= Math.round(limitPct * 100) * total
}

export function classifyCounts(affected: number, total: number, t: MetricThresholds): ReputationLevel {
  if (countsAtOrBelow(affected, total, t.green))  return 'green'
  if (countsAtOrBelow(affected, total, t.yellow)) return 'yellow'
  if (countsAtOrBelow(affected, total, t.orange)) return 'orange'
  return 'red'
}

export function levelRank(level: ReputationLevel): number {
  return LEVEL_ORDER.indexOf(level)
}

export function worstLevel(levels: Array<ReputationLevel | 'unknown'>): ReputationLevel | 'unknown' {
  const known = levels.filter((l): l is ReputationLevel => l !== 'unknown')
  if (known.length === 0) return 'unknown'
  return known.reduce((w, l) => (levelRank(l) > levelRank(w) ? l : w), known[0])
}

/** Limite superior da faixa e faixa seguinte. Vermelho não tem teto. */
export function bandBounds(level: ReputationLevel, t: MetricThresholds): {
  lower: number
  upper: number | null
  next:  ReputationLevel | null
} {
  switch (level) {
    case 'green':  return { lower: 0,        upper: t.green,  next: 'yellow' }
    case 'yellow': return { lower: t.green,  upper: t.yellow, next: 'orange' }
    case 'orange': return { lower: t.yellow, upper: t.orange, next: 'red' }
    default:       return { lower: t.orange, upper: null,     next: null }
  }
}
