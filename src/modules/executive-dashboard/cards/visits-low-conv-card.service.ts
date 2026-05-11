import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/**
 * F11 Fase 2 — Card "Visit Low Conv".
 *
 * Consome view `v_leaderboard_visits_low_conv` v2 (benchmark hierárquico
 * categoria → seller; migration 20260552).
 *
 * Vazzo hoje: 1 opportunity (MLB6087334742 — score 13.1).
 * Quando mais snapshots de visitas acumularem, o leaderboard ganha mais
 * itens (benchmark mais estável).
 */

interface DailyBreakdownPoint {
  date:  string
  total: number
}

export interface VisitsLowConvCardData {
  summary: {
    totalOpportunities:        number
    totalVisitsWasted:         number
    totalGmvUnderperforming:   number
    topGapPct:                 number | null
    benchmarkSourcesMix: {
      category: number
      seller:   number
    }
  }
  items: Array<{
    ml_item_id:              string
    product_id:              string | null
    title:                   string | null
    category_ml_id:          string | null
    permalink:               string | null
    current_price:           number | null
    visits_7d:               number
    orders_7d:               number
    conversion_pct:          number
    benchmark_pct:           number | null
    benchmark_source:        'category' | 'seller' | 'none'
    benchmark_sample_size:   number | null
    gap_pct:                 number | null
    opportunity_score:       number | null
    visits_daily_breakdown:  DailyBreakdownPoint[]
  }>
  lastSyncedAt:              string | null
}

@Injectable()
export class VisitsLowConvCardService {
  private readonly logger = new Logger(VisitsLowConvCardService.name)

  async getCard(orgId: string): Promise<VisitsLowConvCardData> {
    // 1. Top 20 leaderboard
    const { data: rows } = await supabaseAdmin
      .from('v_leaderboard_visits_low_conv')
      .select('*')
      .eq('organization_id', orgId)
      .order('opportunity_score', { ascending: false, nullsFirst: false })
      .limit(20)

    const items: VisitsLowConvCardData['items'] = ((rows ?? []) as Array<{
      ml_item_id:              string
      product_id:              string | null
      title:                   string | null
      category_ml_id:          string | null
      permalink:               string | null
      current_price:           number | null
      visits_7d:               number
      orders_7d:               number
      conversion_pct:          number
      benchmark_pct:           number | null
      benchmark_source:        string
      benchmark_sample_size:   number | null
      gap_pct:                 number | null
      opportunity_score:       number | null
      visits_daily_breakdown:  unknown
    }>).map(r => {
      // Normaliza daily_breakdown — pode vir como array de {date, total} ou ML's {date, total, visits_detail[]}
      const raw = r.visits_daily_breakdown
      const breakdown: DailyBreakdownPoint[] = Array.isArray(raw)
        ? raw
            .map((p: { date?: string; total?: number }) => ({ date: p.date ?? '', total: Number(p.total ?? 0) }))
            .filter(p => p.date)
            .sort((a, b) => a.date.localeCompare(b.date))
        : []
      return {
        ml_item_id:             r.ml_item_id,
        product_id:             r.product_id,
        title:                  r.title,
        category_ml_id:         r.category_ml_id,
        permalink:              r.permalink,
        current_price:          r.current_price,
        visits_7d:              r.visits_7d,
        orders_7d:              r.orders_7d,
        conversion_pct:         r.conversion_pct,
        benchmark_pct:          r.benchmark_pct,
        benchmark_source:       (r.benchmark_source === 'category' || r.benchmark_source === 'seller')
                                 ? r.benchmark_source
                                 : 'none' as const,
        benchmark_sample_size:  r.benchmark_sample_size,
        gap_pct:                r.gap_pct,
        opportunity_score:      r.opportunity_score,
        visits_daily_breakdown: breakdown,
      }
    })

    // 2. Summary (todos rows do org, não só top 20 — pra somas corretas)
    const { data: all } = await supabaseAdmin
      .from('v_leaderboard_visits_low_conv')
      .select('visits_7d, gmv_7d, gap_pct, benchmark_source')
      .eq('organization_id', orgId)
    const allRows = (all ?? []) as Array<{
      visits_7d: number
      gmv_7d:    number
      gap_pct:   number | null
      benchmark_source: string
    }>

    const totalOpportunities      = allRows.length
    const totalVisitsWasted       = allRows.reduce((s, r) => s + (r.visits_7d ?? 0), 0)
    const totalGmvUnderperforming = allRows.reduce((s, r) => s + Number(r.gmv_7d ?? 0), 0)
    const topGapPct               = allRows.length > 0
      ? Math.max(...allRows.map(r => r.gap_pct ?? 0))
      : null
    const benchmarkSourcesMix = {
      category: allRows.filter(r => r.benchmark_source === 'category').length,
      seller:   allRows.filter(r => r.benchmark_source === 'seller').length,
    }

    // 3. lastSyncedAt — máximo de ml_item_visits_period
    const { data: lastSync } = await supabaseAdmin
      .from('ml_item_visits_period')
      .select('last_synced_at')
      .eq('organization_id', orgId)
      .eq('period_days', 7)
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastSyncedAt = (lastSync as { last_synced_at: string } | null)?.last_synced_at ?? null

    return {
      summary: {
        totalOpportunities,
        totalVisitsWasted,
        totalGmvUnderperforming,
        topGapPct,
        benchmarkSourcesMix,
      },
      items,
      lastSyncedAt,
    }
  }
}
