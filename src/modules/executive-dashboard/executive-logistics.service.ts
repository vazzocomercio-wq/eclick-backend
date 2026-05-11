import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

/**
 * F11 E3 — Logística (delays + Flex).
 *
 * - scanDelays(orgId, sellerId, daysBack=30)
 *     Itera shipping_id distintos de orders recentes, chama
 *     /shipments/{id}/delays. 404 = sem atraso (positivo) — marca
 *     resolvido. 200 = atraso ativo — UPSERT.
 *
 * - scanFlex(orgId, sellerId)
 *     Itera ml_item_id ativos do seller (via ml_quality_snapshots),
 *     chama /flex/sites/MLB/items/{id}/v2. Resposta é só {has_flex}.
 *
 * - refreshSummary(orgId, sellerId)
 *     Agrega counts em ml_logistics_summary. Lê orders pra
 *     shipments_to_dispatch_today (sem call extra ML).
 *
 * Multi-conta: SEMPRE passa sellerId em getTokenForOrg.
 * Dedupar shipping_id antes de iterar (orders multi-item).
 */

const DEFAULT_DELAY_SCAN_DAYS = 30
const DEFAULT_FLEX_BATCH_SIZE = 100  // limite por scan pra não estourar rate
const FLEX_DELAY_MS           = 60   // pausa entre calls (~16 req/s)

interface MlDelay {
  type?:           'handling_delayed' | 'sla_delayed' | 'transit_delayed' | string
  delayed_days?:   number
  expected_date?:  string
  actual_date?:    string
}

@Injectable()
export class ExecutiveLogisticsService {
  private readonly logger = new Logger(ExecutiveLogisticsService.name)

  constructor(private readonly ml: MercadolivreService) {}

  // ── Scan: delays ─────────────────────────────────────────────────────────

  async scanDelays(orgId: string, sellerId: number, daysBack = DEFAULT_DELAY_SCAN_DAYS): Promise<{
    shipments_checked: number
    delays_found:      number
    auto_resolved:     number
  }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // 1. Coleta shipping_ids distintos de orders recentes da conta
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('shipping_id, external_order_id')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('platform',        'mercadolivre')
      .not('shipping_id', 'is', null)
      .gte('created_at',     since)
      .limit(2000)

    const seen = new Map<string, string | null>()   // shipping_id → external_order_id
    for (const r of (rows ?? []) as Array<{ shipping_id: string | null; external_order_id: string | null }>) {
      if (r.shipping_id && !seen.has(r.shipping_id)) seen.set(r.shipping_id, r.external_order_id ?? null)
    }

    let delaysFound  = 0
    let autoResolved = 0

    // 2. Pra cada shipping_id único, checa /delays
    for (const [shipId, orderId] of seen) {
      try {
        const res = await axios.get<MlDelay[] | { delays?: MlDelay[] }>(
          `https://api.mercadolibre.com/shipments/${shipId}/delays`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000, validateStatus: s => s < 500 },
        )

        if (res.status === 404) {
          // Sem delay — auto-resolve delays anteriores deste shipment
          const { data: resolved } = await supabaseAdmin
            .from('ml_shipment_delays')
            .update({ status: 'auto_resolved', resolved_at: new Date().toISOString() })
            .eq('ml_shipment_id', shipId)
            .eq('status', 'open')
            .select('id')
          if (resolved && resolved.length > 0) autoResolved += resolved.length
          continue
        }

        if (res.status >= 400) {
          this.logger.warn(`[logistics.delays] ${res.status} shipment=${shipId}`)
          continue
        }

        // Response shape: array direto OU { delays: [...] }
        const raw = res.data as MlDelay[] | { delays?: MlDelay[] }
        const delays: MlDelay[] = Array.isArray(raw) ? raw : (raw.delays ?? [])

        for (const d of delays) {
          const type = d.type as 'handling_delayed' | 'sla_delayed' | 'transit_delayed'
          if (!type || !['handling_delayed', 'sla_delayed', 'transit_delayed'].includes(type)) continue

          const { error } = await supabaseAdmin
            .from('ml_shipment_delays')
            .upsert({
              organization_id: orgId,
              seller_id:       sellerId,
              ml_shipment_id:  shipId,
              ml_order_id:     orderId,
              delay_type:      type,
              delay_days:      d.delayed_days ?? null,
              expected_date:   d.expected_date ?? null,
              actual_date:     d.actual_date ?? null,
              status:          'open',
              raw_response:    d,
              detected_at:     new Date().toISOString(),
            }, { onConflict: 'ml_shipment_id,delay_type' })
          if (!error) delaysFound++
        }
      } catch (err) {
        this.logger.warn(`[logistics.delays] erro shipment=${shipId}: ${(err as Error).message}`)
      }
    }

    return { shipments_checked: seen.size, delays_found: delaysFound, auto_resolved: autoResolved }
  }

  // ── Scan: Flex ───────────────────────────────────────────────────────────

  async scanFlex(orgId: string, sellerId: number, batch = DEFAULT_FLEX_BATCH_SIZE): Promise<{
    items_checked:   number
    flex_eligible:   number
  }> {
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Usa ml_quality_snapshots como fonte de items ativos do seller (mesma
    // estratégia da VIEW v_dashboard_aggregated_metrics).
    const { data: items } = await supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_item_id, product_id')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .limit(batch)

    let eligible = 0
    let checked  = 0

    for (const it of ((items ?? []) as Array<{ ml_item_id: string; product_id: string | null }>)) {
      try {
        const res = await axios.get<{ has_flex?: boolean }>(
          `https://api.mercadolibre.com/flex/sites/MLB/items/${it.ml_item_id}/v2`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8_000, validateStatus: s => s < 500 },
        )
        if (res.status >= 400) {
          this.logger.warn(`[logistics.flex] ${res.status} item=${it.ml_item_id}`)
          continue
        }
        const hasFlex = res.data.has_flex === true
        if (hasFlex) eligible++
        checked++

        await supabaseAdmin
          .from('ml_flex_status')
          .upsert({
            organization_id: orgId,
            seller_id:       sellerId,
            ml_item_id:      it.ml_item_id,
            product_id:      it.product_id,
            has_flex:        hasFlex,
            raw_response:    res.data,
            fetched_at:      new Date().toISOString(),
          }, { onConflict: 'organization_id,seller_id,ml_item_id' })

        // Pausa pra não martelar
        await new Promise(r => setTimeout(r, FLEX_DELAY_MS))
      } catch (err) {
        this.logger.warn(`[logistics.flex] erro item=${it.ml_item_id}: ${(err as Error).message}`)
      }
    }

    return { items_checked: checked, flex_eligible: eligible }
  }

  // ── Refresh summary (agrega counts) ──────────────────────────────────────

  async refreshSummary(orgId: string, sellerId: number): Promise<void> {
    const today    = new Date().toISOString().slice(0, 10)
    const todayStart = `${today}T00:00:00Z`

    // Counts via Postgres
    const [
      toDispatch, dispatched, delivered,
      openDelays, openHandling, openSla, openTransit,
      flexEligible, flexTotal, itemsTotal,
    ] = await Promise.all([
      this.count('orders', { organization_id: orgId, seller_id: sellerId, platform: 'mercadolivre', shipping_status: 'ready_to_ship' }),
      this.countGte('orders', { organization_id: orgId, seller_id: sellerId, platform: 'mercadolivre', shipping_status: 'shipped' }, 'updated_at', todayStart),
      this.countGte('orders', { organization_id: orgId, seller_id: sellerId, platform: 'mercadolivre', shipping_status: 'delivered' }, 'updated_at', todayStart),
      this.count('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open' }),
      this.count('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open', delay_type: 'handling_delayed' }),
      this.count('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open', delay_type: 'sla_delayed' }),
      this.count('ml_shipment_delays', { organization_id: orgId, seller_id: sellerId, status: 'open', delay_type: 'transit_delayed' }),
      this.count('ml_flex_status', { organization_id: orgId, seller_id: sellerId, has_flex: true }),
      this.count('ml_flex_status', { organization_id: orgId, seller_id: sellerId }),
      this.count('ml_quality_snapshots', { organization_id: orgId, seller_id: sellerId }),
    ])

    const coverage = itemsTotal > 0 ? (flexTotal / itemsTotal) * 100 : 0

    const { error } = await supabaseAdmin
      .from('ml_logistics_summary')
      .upsert({
        organization_id:                orgId,
        seller_id:                      sellerId,
        shipments_to_dispatch_today:    toDispatch,
        shipments_dispatched_today:     dispatched,
        shipments_delivered_today:      delivered,
        open_delays_count:              openDelays,
        open_delays_handling:           openHandling,
        open_delays_sla:                openSla,
        open_delays_transit:            openTransit,
        flex_eligible_count:            flexEligible,
        flex_scan_coverage_pct:         Math.round(coverage * 10) / 10,
        last_synced_at:                 new Date().toISOString(),
        next_sync_at:                   new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'organization_id,seller_id' })
    if (error) throw new Error(`logistics summary upsert: ${error.message}`)
  }

  // ── Reads pra UI ─────────────────────────────────────────────────────────

  async getSummaryForOrg(orgId: string): Promise<Array<{
    seller_id:                          number
    shipments_to_dispatch_today:        number
    shipments_dispatched_today:         number
    open_delays_count:                  number
    open_delays_handling:               number
    open_delays_sla:                    number
    open_delays_transit:                number
    flex_eligible_count:                number
    flex_scan_coverage_pct:             number | null
    last_synced_at:                     string
  }>> {
    const { data } = await supabaseAdmin
      .from('ml_logistics_summary')
      .select('*')
      .eq('organization_id', orgId)
    return (data ?? []) as Array<{
      seller_id:                   number
      shipments_to_dispatch_today: number
      shipments_dispatched_today:  number
      open_delays_count:           number
      open_delays_handling:        number
      open_delays_sla:             number
      open_delays_transit:         number
      flex_eligible_count:         number
      flex_scan_coverage_pct:      number | null
      last_synced_at:              string
    }>
  }

  async listOpenDelays(orgId: string, sellerId?: number, limit = 50): Promise<unknown[]> {
    let q = supabaseAdmin
      .from('ml_shipment_delays')
      .select('id, seller_id, ml_shipment_id, ml_order_id, delay_type, delay_days, expected_date, detected_at')
      .eq('organization_id', orgId)
      .eq('status', 'open')
      .order('detected_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500))
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data } = await q
    return (data ?? []) as unknown[]
  }

  async listFlexEligible(orgId: string, sellerId: number, limit = 100): Promise<Array<{
    ml_item_id: string
    product_id: string | null
    fetched_at: string
  }>> {
    const { data } = await supabaseAdmin
      .from('ml_flex_status')
      .select('ml_item_id, product_id, fetched_at')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('has_flex',        true)
      .order('fetched_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500))
    return (data ?? []) as Array<{ ml_item_id: string; product_id: string | null; fetched_at: string }>
  }

  /** Lê current summary pra mergear no ml_dashboard_summary. */
  async fetchSummaryRow(orgId: string, sellerId: number): Promise<{
    shipments_to_dispatch_today: number
    shipments_late:              number
    flex_active_listings:        number
  } | null> {
    const { data } = await supabaseAdmin
      .from('ml_logistics_summary')
      .select('shipments_to_dispatch_today, open_delays_count, flex_eligible_count')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .maybeSingle()
    if (!data) return null
    const d = data as { shipments_to_dispatch_today: number; open_delays_count: number; flex_eligible_count: number }
    return {
      shipments_to_dispatch_today: d.shipments_to_dispatch_today,
      shipments_late:              d.open_delays_count,
      flex_active_listings:        d.flex_eligible_count,
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async count(table: string, filters: Record<string, unknown>): Promise<number> {
    let q = supabaseAdmin.from(table).select('*', { count: 'exact', head: true })
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
    const { count } = await q
    return count ?? 0
  }

  private async countGte(
    table: string,
    filters: Record<string, unknown>,
    column: string,
    value: string,
  ): Promise<number> {
    let q = supabaseAdmin.from(table).select('*', { count: 'exact', head: true })
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v)
    q = q.gte(column, value)
    const { count } = await q
    return count ?? 0
  }
}
