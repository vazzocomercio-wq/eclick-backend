/** Computa score 0-100 + level a partir do adoption_status do ML.
 *
 *  Como o endpoint /items/:id/performance NAO existe no ML API, derivamos
 *  o score a partir do /catalog_quality/status (que retorna PI/FT/all
 *  attribute counts).
 *
 *  Pesos:
 *  - PI (Product Information — basico, 1-2 attrs): 25 pontos
 *  - FT (Ficha Tecnica — geralmente 5-30 attrs): 60 pontos
 *  - all (consolidado obrigatorio + opcional):    15 pontos (bonus)
 *
 *  Levels (alinhado com nomenclatura ML):
 *  - basic         (score < 60)
 *  - satisfactory  (60-84)
 *  - professional  (85-100)
 */

import type { MlAdoptionStatus, MlQualityLevel } from './ml-quality.types'

interface DimAgg {
  filled:  number
  missing: number
  total:   number
  pct:     number
}

export function computeDimAgg(dim: MlAdoptionStatus['pi'] | MlAdoptionStatus['ft'] | MlAdoptionStatus['all']): DimAgg {
  const filled  = (dim?.attributes ?? []).length
  const missing = (dim?.missing_attributes ?? []).length
  const total   = filled + missing
  const pct     = total === 0 ? 100 : Math.round((filled / total) * 100)
  return { filled, missing, total, pct }
}

export function computeScore(adoption: MlAdoptionStatus): number {
  const pi  = computeDimAgg(adoption.pi)
  const ft  = computeDimAgg(adoption.ft)
  const all = computeDimAgg(adoption.all)

  const piScore  = (pi.pct  / 100) * 25
  const ftScore  = (ft.pct  / 100) * 60
  const allScore = (all.pct / 100) * 15

  return Math.round(piScore + ftScore + allScore)
}

export function computeLevel(score: number): MlQualityLevel {
  if (score >= 85) return 'professional'
  if (score >= 60) return 'satisfactory'
  return 'basic'
}

export interface PriorityResult {
  score:                       number  // 0-100
  complexity:                  'easy' | 'medium' | 'hard' | 'blocked'
  estimated_score_after_fix:   number  // 0-100
}

/** Calcula prioridade interna combinando distancia ate 100 + tags ML.
 *  Sem dados de vendas ainda (depende de outra integracao); placeholder
 *  pra evolucao C4. */
export function computeInternalPriority(
  currentScore: number,
  hasPenalty:   boolean,
  totalMissing: number,
): PriorityResult {
  let score      = 0
  let complexity: PriorityResult['complexity'] = 'easy'
  let gain       = 0

  // Distancia ate 100% (peso 50)
  const distance = 100 - currentScore
  if (distance <= 10) {
    score += 50
    complexity = 'easy'
    gain = distance
  } else if (distance <= 25) {
    score += 35
    complexity = 'medium'
    gain = Math.round(distance * 0.7)
  } else {
    score += 15
    complexity = 'hard'
    gain = Math.round(distance * 0.5)
  }

  // Penalizacao (peso 30) — alta prioridade de correcao
  if (hasPenalty) score += 30

  // Quantidade de missing attrs (peso 20 inverso) — quanto menos faltar, mais facil
  if (totalMissing <= 3)       score += 20
  else if (totalMissing <= 8)  score += 12
  else if (totalMissing <= 15) score += 6

  return {
    score:                     Math.min(score, 100),
    complexity,
    estimated_score_after_fix: Math.min(100, currentScore + gain),
  }
}
