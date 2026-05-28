import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import {
  ShopMetricsSnapshot, ShopMetricAlert, ShopHealthCard, HealthStatus,
  QUALITY_THRESHOLDS,
} from './shopee-quality.types'

/** F18 F1.3 — Quality Center service.
 *
 *  - getLatest(orgId, shopId?) → snapshots mais recentes por shop_id.
 *  - saveSnapshot(snapshot)    → upsert idempotente por (org, shop, date).
 *  - evaluateHealth(metrics)   → status + alertas baseado em thresholds.
 *
 *  evaluateHealth() é puro (sem I/O) → testável sem DB. Thresholds vêm de
 *  QUALITY_THRESHOLDS pra ser único ponto de verdade entre service + UI
 *  + docs. */
@Injectable()
export class ShopeeQualityService {
  private readonly logger = new Logger(ShopeeQualityService.name)

  /** Lê snapshots mais recentes via view v_latest_shop_metrics.
   *  Sem shopId → todas as lojas conectadas da org. */
  async getLatest(orgId: string, shopId?: number): Promise<ShopHealthCard[]> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('v_latest_shop_metrics')
      .select('*')
      .eq('organization_id', orgId)

    if (shopId != null) q = q.eq('shop_id', shopId)

    const { data, error } = await q
    if (error) {
      this.logger.error(`[shopee.quality] query falhou: ${error.message}`)
      throw new Error(error.message)
    }

    return ((data ?? []) as unknown as RowLatest[]).map(r => this.toCard(r))
  }

  /** Histórico de uma loja (max N dias) — pra mini gráficos de tendência. */
  async getHistory(orgId: string, shopId: number, days = 30): Promise<ShopMetricsSnapshot[]> {
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('shop_metrics')
      .select('*')
      .eq('organization_id', orgId)
      .eq('shop_id', shopId)
      .gte('snapshot_date', since)
      .order('snapshot_date', { ascending: true })

    if (error) throw new Error(error.message)
    return ((data ?? []) as unknown as ShopMetricsSnapshot[])
  }

  /** Upsert idempotente — UNIQUE (org, shop, date) garante 1 snapshot/dia. */
  async saveSnapshot(s: ShopMetricsSnapshot): Promise<void> {
    const { error } = await supabaseAdmin
      .schema('shopee')
      .from('shop_metrics')
      .upsert({
        organization_id:        s.organization_id,
        shop_id:                s.shop_id,
        snapshot_date:          s.snapshot_date,
        chat_response_rate:     s.chat_response_rate     ?? null,
        chat_response_time_min: s.chat_response_time_min ?? null,
        prep_time_days:         s.prep_time_days         ?? null,
        late_ship_rate:         s.late_ship_rate         ?? null,
        return_refund_rate:     s.return_refund_rate     ?? null,
        rating:                 s.rating                 ?? null,
        penalty_points:         s.penalty_points         ?? null,
        raw:                    s.raw                    ?? null,
        source:                 s.source                 ?? 'api',
      }, { onConflict: 'organization_id,shop_id,snapshot_date' })
    if (error) {
      this.logger.error(`[shopee.quality] saveSnapshot: ${error.message}`)
      throw new Error(error.message)
    }
  }

  /** Avalia saúde da loja a partir de uma snapshot — puro, sem I/O.
   *
   *  Lógica:
   *  - penalty_points >= critical (6) → critical (override)
   *  - penalty_points >= warning  (3) OU qualquer métrica critical → warning
   *  - alguma métrica em zona warning → attention
   *  - tudo OK → healthy
   *
   *  Métricas null não geram alerta nem afetam status (ausência ≠ violação). */
  evaluateHealth(snap: ShopMetricsSnapshot): { status: HealthStatus; alerts: ShopMetricAlert[] } {
    const alerts: ShopMetricAlert[] = []
    let highest: HealthStatus = 'healthy'

    const bump = (next: HealthStatus) => {
      const order = { healthy: 0, attention: 1, warning: 2, critical: 3 }
      if (order[next] > order[highest]) highest = next
    }

    // Penalty — override que pode levar direto a critical
    if (snap.penalty_points != null) {
      if (snap.penalty_points >= QUALITY_THRESHOLDS.penalty_points.critical) {
        alerts.push({
          severity:   'critical',
          code:       'penalty_critical',
          metric:     'penalty_points',
          description:`${snap.penalty_points} pontos de punição — risco IMINENTE de suspensão.`,
          recommended_action: 'EMERGÊNCIA: contatar Shopee + sanar violações + protocolar recurso.',
          current_value: snap.penalty_points,
          target_value:  0,
        })
        bump('critical')
      } else if (snap.penalty_points >= QUALITY_THRESHOLDS.penalty_points.warning) {
        alerts.push({
          severity:   'warning',
          code:       'penalty_warning',
          metric:     'penalty_points',
          description:`${snap.penalty_points} pontos de punição — aproximando-se do limite (6).`,
          recommended_action: 'Identificar causa raiz e corrigir antes de novos pontos.',
          current_value: snap.penalty_points,
          target_value:  0,
        })
        bump('warning')
      }
    }

    // Chat response rate
    if (snap.chat_response_rate != null) {
      const t = QUALITY_THRESHOLDS.chat_response_rate
      if (snap.chat_response_rate < t.critical) {
        alerts.push({
          severity: 'critical', code: 'chat_rate_critical', metric: 'chat_response_rate',
          description: `Taxa de resposta crítica (${(snap.chat_response_rate * 100).toFixed(0)}%).`,
          recommended_action: 'Plantão imediato + notificações ligadas — Shopee aplica penalty.',
          current_value: `${(snap.chat_response_rate * 100).toFixed(0)}%`,
          target_value:  '≥85%',
        })
        bump('warning')
      } else if (snap.chat_response_rate < t.warning) {
        alerts.push({
          severity: 'warning', code: 'chat_rate_low', metric: 'chat_response_rate',
          description: `Taxa de resposta abaixo do mínimo (${(snap.chat_response_rate * 100).toFixed(0)}% < 85%).`,
          recommended_action: 'Ativar notificações pra todos os atendentes + horários fixos.',
          current_value: `${(snap.chat_response_rate * 100).toFixed(0)}%`,
          target_value:  '≥85%',
        })
        bump('attention')
      }
    }

    // Chat response time
    if (snap.chat_response_time_min != null) {
      const t = QUALITY_THRESHOLDS.chat_response_time_min
      if (snap.chat_response_time_min > t.critical) {
        alerts.push({
          severity: 'critical', code: 'chat_time_critical', metric: 'chat_response_time_min',
          description: `Tempo de resposta crítico (${snap.chat_response_time_min}min > 4h).`,
          recommended_action: 'Escalonar SLA — clientes abandonam carrinho em >2h sem resposta.',
          current_value: `${snap.chat_response_time_min}min`,
          target_value:  '≤60min',
        })
        bump('warning')
      } else if (snap.chat_response_time_min > t.warning) {
        alerts.push({
          severity: 'warning', code: 'chat_time_high', metric: 'chat_response_time_min',
          description: `Tempo de resposta alto (${snap.chat_response_time_min}min).`,
          recommended_action: 'Ajustar pra ≤30min — conversão cai 3-5% por hora extra de espera.',
          current_value: `${snap.chat_response_time_min}min`,
          target_value:  '≤60min',
        })
        bump('attention')
      }
    }

    // Prep time
    if (snap.prep_time_days != null) {
      const t = QUALITY_THRESHOLDS.prep_time_days
      if (snap.prep_time_days > t.critical) {
        alerts.push({
          severity: 'critical', code: 'prep_critical', metric: 'prep_time_days',
          description: `Preparação ${snap.prep_time_days.toFixed(1)}d — atrasa o ranqueamento Shopee.`,
          recommended_action: 'Reduzir pra ≤1d. Ondas de pick&pack + automação ML/Shopee no mesmo CD.',
          current_value: `${snap.prep_time_days.toFixed(1)}d`,
          target_value:  '≤2d',
        })
        bump('warning')
      } else if (snap.prep_time_days > t.warning) {
        alerts.push({
          severity: 'warning', code: 'prep_high', metric: 'prep_time_days',
          description: `Preparação ${snap.prep_time_days.toFixed(1)}d acima do ideal.`,
          recommended_action: 'Ideal ≤1d. Avaliar fluxo logístico + estoque seguro.',
          current_value: `${snap.prep_time_days.toFixed(1)}d`,
          target_value:  '≤2d',
        })
        bump('attention')
      }
    }

    // Late ship
    if (snap.late_ship_rate != null) {
      const t = QUALITY_THRESHOLDS.late_ship_rate
      if (snap.late_ship_rate > t.critical) {
        alerts.push({
          severity: 'critical', code: 'late_critical', metric: 'late_ship_rate',
          description: `Atrasos ${(snap.late_ship_rate * 100).toFixed(1)}% (limite: 5%).`,
          recommended_action: 'Auditar transportadora + buffer de estoque seguro 10%.',
          current_value: `${(snap.late_ship_rate * 100).toFixed(1)}%`,
          target_value:  '≤5%',
        })
        bump('warning')
      } else if (snap.late_ship_rate > t.warning) {
        alerts.push({
          severity: 'warning', code: 'late_high', metric: 'late_ship_rate',
          description: `Atrasos ${(snap.late_ship_rate * 100).toFixed(1)}% — atenção.`,
          recommended_action: 'Monitorar diário; >5% gera penalty de ranqueamento.',
          current_value: `${(snap.late_ship_rate * 100).toFixed(1)}%`,
          target_value:  '≤5%',
        })
        bump('attention')
      }
    }

    // Returns
    if (snap.return_refund_rate != null) {
      const t = QUALITY_THRESHOLDS.return_refund_rate
      if (snap.return_refund_rate > t.critical) {
        alerts.push({
          severity: 'critical', code: 'returns_critical', metric: 'return_refund_rate',
          description: `Devoluções ${(snap.return_refund_rate * 100).toFixed(1)}% — produto/embalagem em risco.`,
          recommended_action: 'Auditar URGENTE: produto, embalagem, descrição. Considere recall de SKU.',
          current_value: `${(snap.return_refund_rate * 100).toFixed(1)}%`,
          target_value:  '≤5%',
        })
        bump('warning')
      } else if (snap.return_refund_rate > t.warning) {
        alerts.push({
          severity: 'warning', code: 'returns_high', metric: 'return_refund_rate',
          description: `Devoluções ${(snap.return_refund_rate * 100).toFixed(1)}% acima do alvo.`,
          recommended_action: 'Mapear motivos de devolução por SKU + atualizar descrição.',
          current_value: `${(snap.return_refund_rate * 100).toFixed(1)}%`,
          target_value:  '≤5%',
        })
        bump('attention')
      }
    }

    // Rating (inverso — quanto menor pior)
    if (snap.rating != null) {
      const t = QUALITY_THRESHOLDS.rating
      if (snap.rating < t.critical) {
        alerts.push({
          severity: 'critical', code: 'rating_critical', metric: 'rating',
          description: `Rating ${snap.rating.toFixed(2)} — visibilidade fortemente penalizada.`,
          recommended_action: 'Plano de recuperação: contato direto com clientes <3 estrelas + troca/reembolso.',
          current_value: snap.rating.toFixed(2),
          target_value:  '≥4.5',
        })
        bump('warning')
      } else if (snap.rating < t.warning) {
        alerts.push({
          severity: 'warning', code: 'rating_low', metric: 'rating',
          description: `Rating ${snap.rating.toFixed(2)} abaixo do ideal (4.5).`,
          recommended_action: 'Pedir review pós-entrega + responder reviews <3 em <24h.',
          current_value: snap.rating.toFixed(2),
          target_value:  '≥4.5',
        })
        bump('attention')
      }
    }

    return { status: highest, alerts }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private toCard(r: RowLatest): ShopHealthCard {
    const snap: ShopMetricsSnapshot = {
      shop_id:                Number(r.shop_id),
      organization_id:        r.organization_id,
      snapshot_date:          r.snapshot_date,
      chat_response_rate:     r.chat_response_rate,
      chat_response_time_min: r.chat_response_time_min,
      prep_time_days:         r.prep_time_days,
      late_ship_rate:         r.late_ship_rate,
      return_refund_rate:     r.return_refund_rate,
      rating:                 r.rating,
      penalty_points:         r.penalty_points,
      raw:                    (r.raw ?? null) as Record<string, unknown> | null,
      source:                 r.source,
    }
    const { status, alerts } = this.evaluateHealth(snap)
    const metricKeys: Array<keyof ShopMetricsSnapshot> = [
      'chat_response_rate', 'chat_response_time_min',
      'prep_time_days', 'late_ship_rate',
      'return_refund_rate', 'rating', 'penalty_points',
    ]
    const filled = metricKeys.reduce((acc, k) => acc + (snap[k] != null ? 1 : 0), 0)
    return {
      shop_id:       snap.shop_id,
      shop_name:     r.shop_name ?? null,
      snapshot_date: snap.snapshot_date,
      status,
      metrics:       snap,
      alerts,
      completeness:  { filled, total: metricKeys.length },
    }
  }
}

interface RowLatest {
  shop_id:                number
  organization_id:        string
  snapshot_date:          string
  chat_response_rate:     number | null
  chat_response_time_min: number | null
  prep_time_days:         number | null
  late_ship_rate:         number | null
  return_refund_rate:     number | null
  rating:                 number | null
  penalty_points:         number | null
  raw:                    unknown
  source:                 'api' | 'extension' | 'manual' | null
  shop_name:              string | null
}
