import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/**
 * F11 Fase 2 — Card "Full Fulfillment".
 *
 * Consome `ml_fulfillment_inventory` (populado pelo seed standalone +
 * scanner Nest futuro). Calcula penetração FULL + items parados (stale =
 * sem venda há 30+ dias).
 *
 * Vazzo hoje (2026-05-11): 0 items FULL — operação é cross-docking +
 * self_service_in. Card mostra empty state factualmente correto.
 */

export interface FullFulfillmentCardData {
  summary: {
    totalSkusActive:     number          // items ML ativos (via ml_quality_snapshots distinct ml_item_id)
    skusInFull:          number          // items com row em ml_fulfillment_inventory hoje
    skusOutsideFull:     number
    fullPenetrationPct:  number
    staleItemsCount:     number          // items FULL com available_quantity > 0 + sem venda 30d
    staleItemsUnits:     number
  }
  staleTopItems: Array<{
    ml_item_id:          string
    inventory_id:        string | null
    available_quantity:  number
    last_sold_at:        string | null
    days_since_sale:     number | null
    listing_title:       string | null
    listing_permalink:   string | null
  }>
  lastSyncedAt:          string | null
}

@Injectable()
export class FullFulfillmentCardService {
  private readonly logger = new Logger(FullFulfillmentCardService.name)

  async getCard(orgId: string): Promise<FullFulfillmentCardData> {
    // 1. Latest snapshot por item (DISTINCT ON via supabase: ordenar + limit no JS)
    const { data: latestRows } = await supabaseAdmin
      .from('ml_fulfillment_inventory')
      .select('item_id, inventory_id, available_quantity, last_sold_at, captured_at')
      .eq('organization_id', orgId)
      .order('captured_at', { ascending: false })

    const seenItems = new Set<string>()
    const latestByItem: Array<{
      item_id: string
      inventory_id: string | null
      available_quantity: number
      last_sold_at: string | null
      captured_at: string
    }> = []
    for (const r of ((latestRows ?? []) as Array<{
      item_id: string
      inventory_id: string | null
      available_quantity: number
      last_sold_at: string | null
      captured_at: string
    }>)) {
      if (seenItems.has(r.item_id)) continue
      seenItems.add(r.item_id)
      latestByItem.push(r)
    }

    // 2. Total ativos do ML (proxy via ml_quality_snapshots — Sprint 1 setou esse padrão)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: activeRows } = await supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_item_id')
      .eq('organization_id', orgId)
      .gte('fetched_at', sevenDaysAgo)
    const totalSkusActive = new Set(((activeRows ?? []) as Array<{ ml_item_id: string }>)
      .map(r => r.ml_item_id).filter(Boolean)).size

    const skusInFull         = latestByItem.length
    const skusOutsideFull    = Math.max(0, totalSkusActive - skusInFull)
    const fullPenetrationPct = totalSkusActive > 0
      ? Math.round((skusInFull / totalSkusActive) * 1000) / 10
      : 0

    // 3. Stale: available_quantity > 0 + (last_sold_at IS NULL OR < now - 30d)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const stale = latestByItem.filter(r =>
      r.available_quantity > 0 &&
      (!r.last_sold_at || new Date(r.last_sold_at) < thirtyDaysAgo)
    )
    const staleItemsCount = stale.length
    const staleItemsUnits = stale.reduce((s, r) => s + (r.available_quantity ?? 0), 0)

    // 4. Top 10 stale by available_quantity
    const topStaleIds = stale
      .sort((a, b) => b.available_quantity - a.available_quantity)
      .slice(0, 10)

    // 5. JOIN com product_listings pra title + permalink
    const ids = topStaleIds.map(s => s.item_id)
    let listingsMap = new Map<string, { listing_title: string | null; listing_permalink: string | null }>()
    if (ids.length > 0) {
      const { data: listings } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id, listing_title, listing_permalink')
        .eq('platform', 'mercadolivre')
        .eq('is_active', true)
        .in('listing_id', ids)
      for (const l of ((listings ?? []) as Array<{ listing_id: string; listing_title: string | null; listing_permalink: string | null }>)) {
        listingsMap.set(l.listing_id, { listing_title: l.listing_title, listing_permalink: l.listing_permalink })
      }
    }

    const now = Date.now()
    const staleTopItems = topStaleIds.map(s => {
      const meta = listingsMap.get(s.item_id) ?? { listing_title: null, listing_permalink: null }
      const days = s.last_sold_at
        ? Math.floor((now - new Date(s.last_sold_at).getTime()) / (24 * 60 * 60 * 1000))
        : null
      return {
        ml_item_id:         s.item_id,
        inventory_id:       s.inventory_id,
        available_quantity: s.available_quantity,
        last_sold_at:       s.last_sold_at,
        days_since_sale:    days,
        listing_title:      meta.listing_title,
        listing_permalink:  meta.listing_permalink,
      }
    })

    const lastSyncedAt = latestByItem.length > 0
      ? latestByItem.reduce((max, r) => r.captured_at > max ? r.captured_at : max, latestByItem[0].captured_at)
      : null

    return {
      summary: {
        totalSkusActive, skusInFull, skusOutsideFull,
        fullPenetrationPct, staleItemsCount, staleItemsUnits,
      },
      staleTopItems,
      lastSyncedAt,
    }
  }
}
