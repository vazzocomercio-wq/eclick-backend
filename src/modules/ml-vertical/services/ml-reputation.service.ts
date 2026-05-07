import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'
import { AlertSignalsService } from '../../intelligence-hub/alert-signals.service'
import type { SignalDraft } from '../../intelligence-hub/analyzers/analyzers.types'
import type { MlReputationApiResponse } from '../ml-vertical.types'

const ML_BASE = 'https://api.mercadolibre.com'

// Thresholds defaults (em pontos percentuais, alinhados com nível ML)
const DEFAULT_THRESHOLDS = {
  warning_claims_rate:    0.015,   // 1.5%
  critical_claims_rate:   0.025,   // 2.5%
  warning_cancel_rate:    0.010,   // 1.0%
  critical_cancel_rate:   0.015,   // 1.5%
  warning_delayed_rate:   0.07,    // 7%
  critical_delayed_rate:  0.10,    // 10%
}

export interface ReputationSnapshotRow {
  id:                       string
  organization_id:          string
  seller_id:                number
  snapshot_date:            string
  level_id:                 string | null
  power_seller_status:      string | null
  total_transactions:       number | null
  completed_transactions:   number | null
  cancelled_transactions:   number | null
  claims_rate:              number | null
  claims_count:             number | null
  cancellations_rate:       number | null
  cancellations_count:      number | null
  delayed_handling_rate:    number | null
  delayed_handling_count:   number | null
  positive_ratings:         number | null
  neutral_ratings:          number | null
  negative_ratings:         number | null
  raw:                      MlReputationApiResponse | null
  created_at:               string
}

/**
 * Snapshot diário de reputação ML às 6h SP + análise comparativa.
 *
 * Não é polling de mensagens — a API ML não emite evento quando reputação
 * muda, então depende de pull diário. Está alinhado com a política
 * realtime-first (memory feedback_realtime_first.md): polling lento (24h)
 * só pra dado que o provedor não notifica.
 */
@Injectable()
export class MlReputationService {
  private readonly logger = new Logger(MlReputationService.name)

  constructor(
    private readonly ml:      MercadolivreService,
    private readonly signals: AlertSignalsService,
  ) {}

  @Cron('0 6 * * *', { name: 'ml-reputation-snapshot', timeZone: 'America/Sao_Paulo' })
  async dailySnapshot(): Promise<void> {
    if (process.env.DISABLE_ML_REPUTATION_WORKER === 'true') return

    // Busca todas as conexões ML ativas
    const { data: rows } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id, seller_id')
    const connections = ((rows ?? []) as Array<{ organization_id: string; seller_id: number }>)
    if (connections.length === 0) return

    let snapshotted = 0
    let alerted     = 0
    for (const conn of connections) {
      try {
        const snap = await this.snapshotForOrg(conn.organization_id, conn.seller_id)
        if (snap) {
          snapshotted++
          const previous = await this.findPreviousSnapshot(conn.organization_id, conn.seller_id, snap.snapshot_date)
          const wasAlerted = await this.compareAndEmit(snap, previous)
          if (wasAlerted) alerted++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logger.error(`[ml-reputation] snapshot org=${conn.organization_id} seller=${conn.seller_id} falhou: ${msg}`)
      }
    }

    if (snapshotted > 0) {
      this.logger.log(`[ml-reputation] daily snapshot: ${snapshotted} sellers, ${alerted} alertas`)
    }
  }

  /** Pode ser chamado manualmente via endpoint pra trigger imediato. */
  async snapshotForOrg(orgId: string, sellerId: number): Promise<ReputationSnapshotRow | null> {
    let token: string
    try {
      const res = await this.ml.getTokenForOrg(orgId, sellerId)
      token = res.token
    } catch (e) {
      this.logger.warn(`[ml-reputation] sem token org=${orgId} seller=${sellerId}: ${(e as Error).message}`)
      return null
    }

    let reputation: MlReputationApiResponse
    try {
      const { data } = await axios.get<MlReputationApiResponse>(
        `${ML_BASE}/users/${sellerId}/reputation`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15_000 },
      )
      reputation = data
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      this.logger.warn(`[ml-reputation] fetch falhou seller=${sellerId} status=${status}: ${(e as Error).message}`)
      return null
    }

    const today = new Date().toISOString().slice(0, 10)
    const payload = {
      organization_id:        orgId,
      seller_id:              sellerId,
      snapshot_date:          today,
      level_id:               reputation.level_id ?? null,
      power_seller_status:    reputation.power_seller_status ?? null,
      total_transactions:     reputation.transactions?.total ?? null,
      completed_transactions: reputation.transactions?.completed ?? null,
      cancelled_transactions: reputation.transactions?.canceled ?? null,
      claims_rate:            reputation.metrics?.claims?.rate            ?? null,
      claims_count:           reputation.metrics?.claims?.value           ?? null,
      cancellations_rate:     reputation.metrics?.cancellations?.rate     ?? null,
      cancellations_count:    reputation.metrics?.cancellations?.value    ?? null,
      delayed_handling_rate:  reputation.metrics?.delayed_handling_time?.rate  ?? null,
      delayed_handling_count: reputation.metrics?.delayed_handling_time?.value ?? null,
      positive_ratings:       reputation.transactions?.ratings?.positive ?? null,
      neutral_ratings:        reputation.transactions?.ratings?.neutral  ?? null,
      negative_ratings:       reputation.transactions?.ratings?.negative ?? null,
      raw:                    reputation as unknown,
    }

    const { data, error } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .upsert(payload, { onConflict: 'organization_id,seller_id,snapshot_date' })
      .select('*')
      .single()
    if (error) {
      this.logger.warn(`[ml-reputation] upsert falhou: ${error.message}`)
      return null
    }
    return data as ReputationSnapshotRow
  }

  private async findPreviousSnapshot(
    orgId: string,
    sellerId: number,
    excludeDate: string,
  ): Promise<ReputationSnapshotRow | null> {
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .select('*')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .neq('snapshot_date', excludeDate)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as ReputationSnapshotRow | null) ?? null
  }

  /**
   * Compara snapshot atual com anterior, dispara signal se cruzou threshold
   * piorando. Não dispara se está melhorando (= reputação subindo).
   * Retorna true se gerou signal.
   */
  private async compareAndEmit(
    current:  ReputationSnapshotRow,
    previous: ReputationSnapshotRow | null,
  ): Promise<boolean> {
    const t = DEFAULT_THRESHOLDS
    const triggers: string[] = []
    let severity: 'warning' | 'critical' = 'warning'

    if (current.claims_rate !== null) {
      const prev = previous?.claims_rate ?? 0
      if (current.claims_rate >= t.critical_claims_rate && prev < t.critical_claims_rate) {
        triggers.push(`Reclamações: ${pct(current.claims_rate)} (crítico, limite ${pct(t.critical_claims_rate)})`)
        severity = 'critical'
      } else if (current.claims_rate >= t.warning_claims_rate && prev < t.warning_claims_rate) {
        triggers.push(`Reclamações: ${pct(current.claims_rate)} (aviso, limite ${pct(t.warning_claims_rate)})`)
      }
    }
    if (current.cancellations_rate !== null) {
      const prev = previous?.cancellations_rate ?? 0
      if (current.cancellations_rate >= t.critical_cancel_rate && prev < t.critical_cancel_rate) {
        triggers.push(`Cancelamentos: ${pct(current.cancellations_rate)} (crítico, limite ${pct(t.critical_cancel_rate)})`)
        severity = 'critical'
      } else if (current.cancellations_rate >= t.warning_cancel_rate && prev < t.warning_cancel_rate) {
        triggers.push(`Cancelamentos: ${pct(current.cancellations_rate)} (aviso, limite ${pct(t.warning_cancel_rate)})`)
      }
    }
    if (current.delayed_handling_rate !== null) {
      const prev = previous?.delayed_handling_rate ?? 0
      if (current.delayed_handling_rate >= t.critical_delayed_rate && prev < t.critical_delayed_rate) {
        triggers.push(`Atraso de envio: ${pct(current.delayed_handling_rate)} (crítico, limite ${pct(t.critical_delayed_rate)})`)
        severity = 'critical'
      } else if (current.delayed_handling_rate >= t.warning_delayed_rate && prev < t.warning_delayed_rate) {
        triggers.push(`Atraso de envio: ${pct(current.delayed_handling_rate)} (aviso, limite ${pct(t.warning_delayed_rate)})`)
      }
    }

    if (triggers.length === 0) return false

    const score = severity === 'critical' ? 85 : 60
    const draft: SignalDraft = {
      analyzer:    'ml',
      category:    'reputation_dropped',
      severity,
      score,
      entity_type: null,
      entity_id:   null,
      entity_name: null,
      data: {
        snapshot_id:      current.id,
        seller_id:        current.seller_id,
        level_id:         current.level_id,
        triggers,
        current: {
          claims_rate:           current.claims_rate,
          cancellations_rate:    current.cancellations_rate,
          delayed_handling_rate: current.delayed_handling_rate,
        },
        previous: previous ? {
          claims_rate:           previous.claims_rate,
          cancellations_rate:    previous.cancellations_rate,
          delayed_handling_rate: previous.delayed_handling_rate,
        } : null,
      },
      summary_pt:    `📉 Reputação ML em risco — ${current.level_id ?? 'nível desconhecido'}\n${triggers.join('\n')}`,
      suggestion_pt: 'Acesse o painel ML pra ver detalhes e tomar ação imediata. Reputação cair muda termômetro e ranking.',
    }
    await this.signals.insertMany(current.organization_id, [draft])
    return true
  }

  // ── Métodos pra controller ─────────────────────────────────────────────

  async getLatestForOrg(orgId: string): Promise<ReputationSnapshotRow | null> {
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .select('*')
      .eq('organization_id', orgId)
      .order('snapshot_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as ReputationSnapshotRow | null) ?? null
  }

  async getHistoryForOrg(orgId: string, days = 30): Promise<ReputationSnapshotRow[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    const { data } = await supabaseAdmin
      .from('ml_seller_reputation_snapshots')
      .select('*')
      .eq('organization_id', orgId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true })
    return (data ?? []) as ReputationSnapshotRow[]
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`
}
