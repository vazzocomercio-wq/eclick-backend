import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketSignal, RadarSummary, SignalType } from './shopee-radar.types'

/** F18 F1.5 — Radar Shopee service. READ-ONLY na Sprint 1; coletor que
 *  popula a tabela vem na Sprint 2 com creds Open Platform aprovadas.
 *
 *  Devolve sinais MAIS RECENTES por (signal_type, category_id, item_id?)
 *  via view shopee.v_latest_market_signals. */
@Injectable()
export class ShopeeRadarService {
  private readonly logger = new Logger(ShopeeRadarService.name)

  /** Resumo agrupado por tipo — alimenta o dashboard Radar. */
  async summary(orgId: string): Promise<RadarSummary> {
    const { data, error } = await supabaseAdmin
      .schema('shopee')
      .from('v_latest_market_signals')
      .select('*')
      .eq('organization_id', orgId)
      .order('captured_at', { ascending: false })
    if (error) {
      this.logger.error(`[shopee.radar] summary falhou: ${error.message}`)
      throw new Error(error.message)
    }
    const rows = (data ?? []) as unknown as Row[]
    const items = rows.map(r => this.toSignal(r))
    return {
      trending:        items.filter(it => it.signal_type === 'trending'),
      price_benchmark: items.filter(it => it.signal_type === 'price_benchmark'),
      fbs_adoption:    items.filter(it => it.signal_type === 'fbs_adoption'),
    }
  }

  /** Lista por tipo + categoria — usado em drill-down futuro. */
  async listByType(orgId: string, type: SignalType, categoryId?: number): Promise<MarketSignal[]> {
    let q = supabaseAdmin
      .schema('shopee')
      .from('v_latest_market_signals')
      .select('*')
      .eq('organization_id', orgId)
      .eq('signal_type', type)
      .order('captured_at', { ascending: false })

    if (categoryId != null) q = q.eq('category_id', categoryId)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return ((data ?? []) as unknown as Row[]).map(r => this.toSignal(r))
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private toSignal(r: Row): MarketSignal {
    return {
      id:               r.id,
      organization_id:  r.organization_id,
      signal_type:      r.signal_type as SignalType,
      category_id:      Number(r.category_id),
      category_name:    r.category_name ?? null,
      item_id:          r.item_id != null ? Number(r.item_id) : null,
      metric_value:     Number(r.metric_value),
      payload:          (r.payload ?? {}) as MarketSignal['payload'],
      captured_at:      r.captured_at,
    }
  }
}

interface Row {
  id:               string
  organization_id:  string
  signal_type:      string
  category_id:      number
  category_name:    string | null
  item_id:          number | null
  metric_value:     number
  payload:          unknown
  captured_at:      string
}
