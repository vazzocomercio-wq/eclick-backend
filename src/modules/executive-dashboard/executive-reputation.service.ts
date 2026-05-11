import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

/**
 * F11 E2 — Reputação.
 *
 * 1×/hora chama GET /users/{id} → `seller_reputation`. Salva snapshot
 * histórico + atualiza cache do current + calcula trend (comparando com
 * snapshot anterior).
 *
 * Decisões (vide reference_ml_api_shapes_f11):
 *   - API ML retorna `claims` (não `complaints`). period = "60 days" com espaço.
 *   - rate = fração 0-1.
 *   - Limites ML: claims < 1%, cancellations < 0.5%, late_handling < 6%
 *   - Risk amber: claims ≥ 0.8%, cancellations ≥ 0.4%, late ≥ 5%
 *   - Schema da tabela snapshots herda nomes de outro módulo
 *     (claims_rate / delayed_handling_rate etc).
 *
 * Multi-conta: SEMPRE passa sellerId em getTokenForOrg (feedback_ml_multiconta_token).
 */

const RISK_THRESHOLDS = {
  claims:        0.008,  // 0.8% — limite ML é 1%
  cancellations: 0.004,  // 0.4% — limite ML é 0.5%
  late_handling: 0.05,   // 5%   — limite ML é 6%
}

const LEVEL_COLOR: Record<string, string> = {
  '5_green':       'green',
  '4_light_green': 'light_green',
  '3_yellow':      'yellow',
  '2_orange':      'orange',
  '1_red':         'red',
  '0_red':         'red',
}

const MERCADO_LIDER_LEVELS = new Set(['5_green', '4_light_green', '3_yellow'])

interface MlMetric {
  period?:    string
  rate?:      number
  value?:     number
}

interface MlSellerReputation {
  level_id?:            string
  power_seller_status?: string
  transactions?: {
    canceled?:  number
    completed?: number
    total?:     number
    period?:    string
    ratings?: {
      positive?: number
      neutral?:  number
      negative?: number
    }
  }
  metrics?: {
    sales?:                  MlMetric
    claims?:                 MlMetric
    cancellations?:          MlMetric
    delayed_handling_time?:  MlMetric
  }
}

interface MlUserResponse {
  id?:                  number
  seller_reputation?:   MlSellerReputation
}

export interface ReputationSnapshot {
  organization_id:         string
  seller_id:               number
  level_id:                string | null
  level_color:             string | null
  power_seller_status:     string | null
  claims_rate:             number | null
  claims_count:            number | null
  cancellations_rate:      number | null
  cancellations_count:     number | null
  delayed_handling_rate:   number | null
  delayed_handling_count:  number | null
  total_transactions:      number | null
  completed_transactions:  number | null
  cancelled_transactions:  number | null
  positive_ratings:        number | null
  neutral_ratings:         number | null
  negative_ratings:        number | null
  is_mercado_lider:        boolean
  is_at_risk:              boolean
  risk_reasons:            string[]
  trend:                   'improving' | 'stable' | 'degrading' | 'unknown'
  last_synced_at:          string
}

@Injectable()
export class ExecutiveReputationService {
  private readonly logger = new Logger(ExecutiveReputationService.name)

  constructor(private readonly ml: MercadolivreService) {}

  // ── Sync ─────────────────────────────────────────────────────────────────

  /**
   * Sincroniza reputação de 1 (org, seller). Idempotente: pode ser chamado
   * repetidamente. Cria snapshot novo (mesmo se idênticos — pra histórico)
   * + UPSERT em current.
   */
  async syncReputation(orgId: string, sellerId: number): Promise<ReputationSnapshot> {
    // 1. Token DA conta específica
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // 2. GET /users/{id}
    const { data: user } = await axios.get<MlUserResponse>(
      `https://api.mercadolibre.com/users/${sellerId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
    )

    const sr = user.seller_reputation ?? {}
    const m  = sr.metrics ?? {}

    // 3. Extração normalizada
    const claims        = m.claims ?? {}
    const cancellations = m.cancellations ?? {}
    const delayed       = m.delayed_handling_time ?? {}
    const tx            = sr.transactions ?? {}
    const ratings       = tx.ratings ?? {}

    const claimsRate  = claims.rate        ?? null
    const cancelRate  = cancellations.rate ?? null
    const delayedRate = delayed.rate       ?? null

    // 4. Avaliar risco
    const riskReasons: string[] = []
    if (claimsRate  != null && claimsRate  >= RISK_THRESHOLDS.claims)        riskReasons.push('claims_above_0_8')
    if (cancelRate  != null && cancelRate  >= RISK_THRESHOLDS.cancellations) riskReasons.push('cancellations_above_0_4')
    if (delayedRate != null && delayedRate >= RISK_THRESHOLDS.late_handling) riskReasons.push('late_handling_above_5')
    const isAtRisk = riskReasons.length > 0

    const levelId    = sr.level_id ?? null
    const levelColor = levelId ? (LEVEL_COLOR[levelId] ?? null) : null
    const isMl       = levelId ? MERCADO_LIDER_LEVELS.has(levelId) : false

    // 5. Snapshot anterior (pra calcular trend)
    const previous = await this.fetchPreviousSnapshot(orgId, sellerId)
    const trend = this.calculateTrend(previous, { claimsRate, cancelRate, delayedRate })

    const snapshotPayload = {
      organization_id:        orgId,
      seller_id:              sellerId,
      snapshot_date:          new Date().toISOString().slice(0, 10),
      level_id:               levelId,
      level_color:            levelColor,
      power_seller_status:    sr.power_seller_status ?? null,
      total_transactions:     tx.total     ?? null,
      completed_transactions: tx.completed ?? null,
      cancelled_transactions: tx.canceled  ?? null,
      claims_rate:            claimsRate,
      claims_count:           claims.value        ?? null,
      claims_period:          claims.period       ?? null,
      cancellations_rate:     cancelRate,
      cancellations_count:    cancellations.value ?? null,
      cancellations_period:   cancellations.period ?? null,
      delayed_handling_rate:  delayedRate,
      delayed_handling_count: delayed.value       ?? null,
      delayed_period:         delayed.period      ?? null,
      transactions_period:    tx.period           ?? null,
      positive_ratings:       ratings.positive ?? null,
      neutral_ratings:        ratings.neutral  ?? null,
      negative_ratings:       ratings.negative ?? null,
      is_mercado_lider:       isMl,
      is_at_risk:             isAtRisk,
      risk_reasons:           riskReasons,
      raw:                    sr,
    }

    // 6. INSERT snapshot
    const { error: snapErr } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .insert(snapshotPayload)
    if (snapErr) throw new Error(`snapshot insert: ${snapErr.message}`)

    // 7. UPSERT current
    const currentPayload = {
      organization_id:        orgId,
      seller_id:              sellerId,
      level_id:               levelId,
      level_color:            levelColor,
      power_seller_status:    sr.power_seller_status ?? null,
      claims_rate:            claimsRate,
      cancellations_rate:     cancelRate,
      delayed_handling_rate:  delayedRate,
      claims_count:           claims.value        ?? null,
      cancellations_count:    cancellations.value ?? null,
      delayed_handling_count: delayed.value       ?? null,
      total_transactions:     tx.total     ?? null,
      completed_transactions: tx.completed ?? null,
      cancelled_transactions: tx.canceled  ?? null,
      positive_ratings:       ratings.positive ?? null,
      neutral_ratings:        ratings.neutral  ?? null,
      negative_ratings:       ratings.negative ?? null,
      is_mercado_lider:       isMl,
      is_at_risk:             isAtRisk,
      risk_reasons:           riskReasons,
      trend,
      trend_calculated_at:    new Date().toISOString(),
      last_synced_at:         new Date().toISOString(),
      next_sync_at:           new Date(Date.now() + 60 * 60 * 1000).toISOString(),  // +1h
    }
    const { error: curErr } = await supabaseAdmin
      .from('ml_seller_reputation_current')
      .upsert(currentPayload, { onConflict: 'organization_id,seller_id' })
    if (curErr) throw new Error(`current upsert: ${curErr.message}`)

    return {
      ...currentPayload,
      trend,
    } as ReputationSnapshot
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  /** Cache (current) de todas as contas da org. */
  async getCurrentForOrg(orgId: string): Promise<ReputationSnapshot[]> {
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_current')
      .select('*')
      .eq('organization_id', orgId)
    return (data ?? []) as ReputationSnapshot[]
  }

  /** Histórico do seller pros últimos N dias (snapshot_date DESC). */
  async getHistory(
    orgId: string,
    sellerId: number,
    days: number,
  ): Promise<Array<{
    snapshot_date:          string
    level_id:               string | null
    claims_rate:            number | null
    cancellations_rate:     number | null
    delayed_handling_rate:  number | null
    is_at_risk:             boolean
    risk_reasons:           string[]
  }>> {
    const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10)
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .select('snapshot_date, level_id, claims_rate, cancellations_rate, delayed_handling_rate, is_at_risk, risk_reasons')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .gte('snapshot_date',  since)
      .order('snapshot_date', { ascending: false })
    return (data ?? []) as Array<{
      snapshot_date:          string
      level_id:               string | null
      claims_rate:            number | null
      cancellations_rate:     number | null
      delayed_handling_rate:  number | null
      is_at_risk:             boolean
      risk_reasons:           string[]
    }>
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async fetchPreviousSnapshot(orgId: string, sellerId: number): Promise<{
    claims_rate:           number | null
    cancellations_rate:    number | null
    delayed_handling_rate: number | null
  } | null> {
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .select('claims_rate, cancellations_rate, delayed_handling_rate')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { claims_rate: number | null; cancellations_rate: number | null; delayed_handling_rate: number | null } | null) ?? null
  }

  private calculateTrend(
    previous: { claims_rate: number | null; cancellations_rate: number | null; delayed_handling_rate: number | null } | null,
    current:  { claimsRate:  number | null; cancelRate:         number | null; delayedRate:           number | null },
  ): 'improving' | 'stable' | 'degrading' | 'unknown' {
    if (!previous) return 'unknown'

    // Deltas significativos: claims/cancellations > 0.1pp (0.001 absoluto),
    // late > 0.5pp (0.005). Acima desses, conta como mudança real.
    const significantDelta = (curr: number | null, prev: number | null, threshold: number): -1 | 0 | 1 => {
      if (curr == null || prev == null) return 0
      const d = curr - prev
      if (d >  threshold) return  1  // piorou
      if (d < -threshold) return -1  // melhorou
      return 0
    }

    const d1 = significantDelta(current.claimsRate,  previous.claims_rate,           0.001)
    const d2 = significantDelta(current.cancelRate,  previous.cancellations_rate,    0.001)
    const d3 = significantDelta(current.delayedRate, previous.delayed_handling_rate, 0.005)

    const degraded = [d1, d2, d3].filter(x => x ===  1).length
    const improved = [d1, d2, d3].filter(x => x === -1).length

    if (degraded >= 2) return 'degrading'
    if (improved >= 2) return 'improving'
    return 'stable'
  }
}
