import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

interface SnapshotRow {
  organization_id: string
  product_id: string
  snapshot_date: string
  marketplace: string
  units_sold: number
  revenue: number
  avg_price: number
  total_cost: number
  gross_profit: number
  margin_pct: number
  cancelled_units: number
  returned_units: number
  stockout_hours: number
  stock_end_of_day: number
}

interface OrderRow {
  product_id: string | null
  source: string | null
  sold_at: string | null
  quantity: number | null
  sale_price: number | null
  cost_price: number | null
  gross_profit: number | null
  contribution_margin: number | null
  status: string | null
}

@Injectable()
export class SnapshotsAggregationService {
  async aggregateDateRange(
    orgId: string,
    dateFrom: string,
    dateTo: string,
    runId: string,
  ): Promise<number> {
    // Fetch all qualifying orders in the range at once
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('product_id, source, sold_at, quantity, sale_price, cost_price, gross_profit, contribution_margin, status')
      .eq('organization_id', orgId)
      .gte('sold_at', dateFrom + 'T00:00:00.000Z')
      .lte('sold_at', dateTo + 'T23:59:59.999Z')
      .not('product_id', 'is', null) as { data: OrderRow[] | null; error: { message: string } | null }

    if (error) {
      console.error('[aggregator] orders fetch error:', error.message)
      throw new Error(error.message)
    }

    if (!orders?.length) return 0

    // Aggregate by product + date + marketplace (specific)
    const snapMap = new Map<string, SnapshotRow>()

    for (const o of orders) {
      if (!o.product_id || !o.sold_at) continue
      const date = o.sold_at.slice(0, 10)
      const marketplace = o.source ?? 'mercadolivre'
      const key = `${o.product_id}|${date}|${marketplace}`

      const snap = snapMap.get(key) ?? this.emptySnap(orgId, o.product_id, date, marketplace)
      this.accumulateOrder(snap, o)
      snapMap.set(key, snap)
    }

    // Build 'aggregated' rows by summing across marketplaces
    const aggMap = new Map<string, SnapshotRow>()
    for (const snap of snapMap.values()) {
      const key = `${snap.product_id}|${snap.snapshot_date}|aggregated`
      const agg = aggMap.get(key) ?? this.emptySnap(orgId, snap.product_id, snap.snapshot_date, 'aggregated')
      agg.units_sold     += snap.units_sold
      agg.revenue        += snap.revenue
      agg.total_cost     += snap.total_cost
      agg.gross_profit   += snap.gross_profit
      agg.cancelled_units += snap.cancelled_units
      agg.returned_units  += snap.returned_units
      aggMap.set(key, agg)
    }

    // Compute derived fields
    const allSnaps = [...snapMap.values(), ...aggMap.values()]
    for (const snap of allSnaps) {
      snap.avg_price  = snap.units_sold > 0 ? snap.revenue / snap.units_sold : 0
      snap.margin_pct = snap.revenue > 0 ? (snap.gross_profit / snap.revenue) * 100 : 0
    }

    // Upsert in batches
    const BATCH = 100
    let totalUpserted = 0
    for (let i = 0; i < allSnaps.length; i += BATCH) {
      const { error: upsertErr } = await supabaseAdmin
        .from('product_sales_snapshots')
        .upsert(allSnaps.slice(i, i + BATCH), {
          onConflict: 'organization_id,product_id,snapshot_date,marketplace',
          ignoreDuplicates: false,
        })
      if (upsertErr) {
        console.error('[aggregator] snapshot upsert error:', upsertErr.message)
      } else {
        totalUpserted += Math.min(BATCH, allSnaps.length - i)
      }
    }

    // Update run snapshots count
    await supabaseAdmin
      .from('aggregator_runs')
      .update({ snapshots_inserted: totalUpserted })
      .eq('id', runId)

    return totalUpserted
  }

  private emptySnap(orgId: string, productId: string, date: string, marketplace: string): SnapshotRow {
    return {
      organization_id:  orgId,
      product_id:       productId,
      snapshot_date:    date,
      marketplace,
      units_sold:       0,
      revenue:          0,
      avg_price:        0,
      total_cost:       0,
      gross_profit:     0,
      margin_pct:       0,
      cancelled_units:  0,
      returned_units:   0,
      stockout_hours:   0,
      stock_end_of_day: 0,
    }
  }

  private accumulateOrder(snap: SnapshotRow, o: OrderRow): void {
    const qty    = o.quantity ?? 0
    const total  = (o.sale_price ?? 0) * qty
    const gp     = o.contribution_margin ?? o.gross_profit ?? 0
    const cost   = o.cost_price ?? 0
    const status = o.status ?? ''

    if (status === 'cancelled') {
      snap.cancelled_units += qty
    } else if (status === 'returned') {
      snap.returned_units += qty
    } else {
      snap.units_sold   += qty
      snap.revenue      += total
      snap.total_cost   += cost
      snap.gross_profit += gp
    }
  }
}
