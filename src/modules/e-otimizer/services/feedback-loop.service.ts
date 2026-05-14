/**
 * e-Otimizer IA MVP 5 — Feedback Loop.
 *
 * Pra cada otimização APLICADA, captura métricas reais do ML em 3 checkpoints:
 *   T+7d  — visits + sold da primeira semana após aplicar
 *   T+14d — acumulado de 2 semanas
 *   T+30d — acumulado de 30 dias (encerra ciclo)
 *
 * Compara contra metrics_t0 (snapshot do momento de aplicar) e calcula:
 *   sold_delta_since_apply  = sold_now - sold_at_apply
 *   visits_in_window        = visits dos últimos N dias (ML /visits/time_window)
 *
 * Sistema "aprende" empiricamente quais keywords/padrões funcionam — útil
 * pro futuro v2 do scoring (pesar keywords que historicamente convertem).
 */

import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

type Checkpoint = 't7d' | 't14d' | 't30d'

interface MetricsSnapshot {
  captured_at:            string
  sold_quantity:          number
  sold_delta_since_apply: number
  visits_in_window:       number
  window_days:            number
  error?:                 string
}

export interface FeedbackSummary {
  total_optimizations:        number
  total_applied:              number
  total_with_metrics:         number   // pelo menos um checkpoint capturado
  avg_score_before:           number | null
  avg_score_after:            number | null
  score_uplift_avg:           number | null
  total_sold_delta_t7d:       number
  total_sold_delta_t14d:      number
  total_sold_delta_t30d:      number
  total_visits_t7d:           number
  top_winners:                Array<{
    optimization_id: string
    mlb_id:          string
    title:           string
    score_before:    number | null
    score_after:     number | null
    sold_delta_t30d: number | null
    applied_fields:  string[]
    applied_at:      string
  }>
}

@Injectable()
export class FeedbackLoopService {
  private readonly logger = new Logger(FeedbackLoopService.name)

  constructor(private readonly mercadolivre: MercadolivreService) {}

  /**
   * Captura métricas pendentes pra uma otimização aplicada. Decide quais
   * checkpoints estão "due" baseado em applied_at vs agora.
   */
  async captureMetrics(orgId: string, optimizationId: string): Promise<{
    captured: Checkpoint[]
    skipped:  Checkpoint[]
  }> {
    const { data, error } = await supabaseAdmin
      .from('listing_optimizations')
      .select('id, mlb_id, applied_at, metrics_t0, metrics_t7d, metrics_t14d, metrics_t30d, before_snapshot')
      .eq('organization_id', orgId)
      .eq('id', optimizationId)
      .maybeSingle()
    if (error || !data) return { captured: [], skipped: [] }

    const opt = data as Record<string, unknown>
    const appliedAt = opt.applied_at as string | null
    if (!appliedAt) return { captured: [], skipped: [] }

    const ageDays = Math.floor((Date.now() - new Date(appliedAt).getTime()) / (1000 * 60 * 60 * 24))
    const pending: Array<{ key: Checkpoint; window: number }> = []
    if (ageDays >= 7  && !opt.metrics_t7d)  pending.push({ key: 't7d',  window: 7  })
    if (ageDays >= 14 && !opt.metrics_t14d) pending.push({ key: 't14d', window: 14 })
    if (ageDays >= 30 && !opt.metrics_t30d) pending.push({ key: 't30d', window: 30 })

    if (pending.length === 0) return { captured: [], skipped: [] }

    // Fetch metrics from ML ONCE (sold_quantity é cumulativo, e visits aceita window param)
    const mlbId = opt.mlb_id as string
    let soldNow = 0
    try {
      const { token } = await this.mercadolivre.getTokenForOrg(orgId)
      const { data: item } = await axios.get<{ sold_quantity?: number }>(`${ML_BASE}/items/${mlbId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
        params:  { attributes: 'id,sold_quantity' },
      })
      soldNow = Number(item.sold_quantity ?? 0)
    } catch (e) {
      this.logger.warn(`[feedback] fetch item ${mlbId} falhou: ${(e as Error).message}`)
      // Mesmo com erro, registra os checkpoints como tentados com error
      for (const { key, window } of pending) {
        await this.saveCheckpoint(optimizationId, key, {
          captured_at: new Date().toISOString(),
          sold_quantity: 0, sold_delta_since_apply: 0,
          visits_in_window: 0, window_days: window,
          error: `fetch item: ${(e as Error).message}`,
        })
      }
      return { captured: [], skipped: pending.map(p => p.key) }
    }

    const t0Sold = ((opt.metrics_t0 as Record<string, unknown> | null)?.sold_quantity as number | undefined)
                ?? ((opt.before_snapshot as Record<string, unknown> | null)?.sold_quantity as number | undefined)
                ?? 0
    const soldDelta = Math.max(0, soldNow - t0Sold)

    const captured: Checkpoint[] = []
    const skipped:  Checkpoint[] = []

    for (const { key, window } of pending) {
      try {
        const visits = await this.fetchVisitsWindow(orgId, mlbId, window)
        await this.saveCheckpoint(optimizationId, key, {
          captured_at:            new Date().toISOString(),
          sold_quantity:          soldNow,
          sold_delta_since_apply: soldDelta,
          visits_in_window:       visits,
          window_days:            window,
        })
        captured.push(key)
      } catch (e) {
        this.logger.warn(`[feedback] ${optimizationId} ${key} falhou: ${(e as Error).message}`)
        await this.saveCheckpoint(optimizationId, key, {
          captured_at:            new Date().toISOString(),
          sold_quantity:          soldNow,
          sold_delta_since_apply: soldDelta,
          visits_in_window:       0,
          window_days:            window,
          error:                  (e as Error).message,
        })
        skipped.push(key)
      }
    }

    return { captured, skipped }
  }

  /**
   * Roda capture em batch — usado pelo cron diário.
   * Limite de 50 por execução pra não estourar rate limit do ML.
   */
  async captureBatch(limit = 50): Promise<{ processed: number; captured: number; errors: number }> {
    const { data } = await supabaseAdmin
      .from('listing_optimizations')
      .select('id, organization_id')
      .not('applied_at', 'is', null)
      .is('metrics_t30d', null)
      .order('applied_at', { ascending: true })
      .limit(limit)
    const rows = (data ?? []) as Array<{ id: string; organization_id: string }>

    let captured = 0
    let errors = 0
    for (const row of rows) {
      try {
        const r = await this.captureMetrics(row.organization_id, row.id)
        captured += r.captured.length
        if (r.skipped.length > 0) errors++
      } catch (e) {
        this.logger.warn(`[feedback.batch] ${row.id}: ${(e as Error).message}`)
        errors++
      }
    }

    this.logger.log(`[feedback.batch] processed=${rows.length} captured_checkpoints=${captured} errors=${errors}`)
    return { processed: rows.length, captured, errors }
  }

  /**
   * Agregado de métricas pra UI — cards do dashboard + lista de top winners.
   */
  async getSummary(orgId: string): Promise<FeedbackSummary> {
    const { data } = await supabaseAdmin
      .from('listing_optimizations')
      .select('id, mlb_id, before_snapshot, seo_score_before, seo_score_after, applied_at, applied_fields, metrics_t7d, metrics_t14d, metrics_t30d')
      .eq('organization_id', orgId)
      .order('applied_at', { ascending: false })
    const rows = (data ?? []) as Array<Record<string, unknown>>

    const applied = rows.filter(r => r.applied_at != null)
    const withMetrics = applied.filter(r => r.metrics_t7d != null || r.metrics_t14d != null || r.metrics_t30d != null)

    const scoresBefore = applied.map(r => r.seo_score_before as number | null).filter((n): n is number => n != null)
    const scoresAfter  = applied.map(r => r.seo_score_after  as number | null).filter((n): n is number => n != null)

    const sumDelta = (cp: 't7d' | 't14d' | 't30d') =>
      applied.reduce((sum, r) => {
        const m = r[`metrics_${cp}`] as { sold_delta_since_apply?: number } | null
        return sum + (m?.sold_delta_since_apply ?? 0)
      }, 0)
    const sumVisits = (cp: 't7d') =>
      applied.reduce((sum, r) => {
        const m = r[`metrics_${cp}`] as { visits_in_window?: number } | null
        return sum + (m?.visits_in_window ?? 0)
      }, 0)

    // Top winners: maior sold_delta_t30d (ou t14d fallback)
    const winners = applied
      .map(r => {
        const t30 = r.metrics_t30d as { sold_delta_since_apply?: number } | null
        const t14 = r.metrics_t14d as { sold_delta_since_apply?: number } | null
        const delta = t30?.sold_delta_since_apply ?? t14?.sold_delta_since_apply ?? null
        return { row: r, delta }
      })
      .filter(w => w.delta != null && w.delta > 0)
      .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
      .slice(0, 10)
      .map(w => ({
        optimization_id: w.row.id as string,
        mlb_id:          w.row.mlb_id as string,
        title:           (w.row.before_snapshot as { title?: string } | null)?.title ?? '',
        score_before:    w.row.seo_score_before as number | null,
        score_after:     w.row.seo_score_after as number | null,
        sold_delta_t30d: w.delta,
        applied_fields:  (w.row.applied_fields as string[] | null) ?? [],
        applied_at:      w.row.applied_at as string,
      }))

    return {
      total_optimizations: rows.length,
      total_applied:       applied.length,
      total_with_metrics:  withMetrics.length,
      avg_score_before:    scoresBefore.length > 0 ? Math.round(scoresBefore.reduce((s, n) => s + n, 0) / scoresBefore.length) : null,
      avg_score_after:     scoresAfter.length  > 0 ? Math.round(scoresAfter.reduce((s, n) => s + n, 0)  / scoresAfter.length)  : null,
      score_uplift_avg:    scoresBefore.length > 0 && scoresAfter.length > 0
        ? Math.round((scoresAfter.reduce((s, n) => s + n, 0) - scoresBefore.reduce((s, n) => s + n, 0)) / Math.max(scoresBefore.length, scoresAfter.length))
        : null,
      total_sold_delta_t7d:  sumDelta('t7d'),
      total_sold_delta_t14d: sumDelta('t14d'),
      total_sold_delta_t30d: sumDelta('t30d'),
      total_visits_t7d:      sumVisits('t7d'),
      top_winners:           winners,
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private async saveCheckpoint(
    optimizationId: string,
    checkpoint: Checkpoint,
    metrics: MetricsSnapshot,
  ): Promise<void> {
    await supabaseAdmin
      .from('listing_optimizations')
      .update({ [`metrics_${checkpoint}`]: metrics, updated_at: new Date().toISOString() })
      .eq('id', optimizationId)
  }

  /** Soma visitas de um item nas últimas N days. ML expõe via time_window. */
  private async fetchVisitsWindow(orgId: string, mlbId: string, windowDays: number): Promise<number> {
    const { token } = await this.mercadolivre.getTokenForOrg(orgId)
    const { data } = await axios.get<{ results?: Array<{ visits: number }> }>(
      `${ML_BASE}/items/${mlbId}/visits/time_window`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12_000,
        params:  { last: windowDays, unit: 'day' },
      },
    )
    const buckets = data.results ?? []
    return buckets.reduce((sum, b) => sum + (Number(b.visits) || 0), 0)
  }
}
