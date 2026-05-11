import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/**
 * F11 Fase 2 — Card "Flex Opportunity".
 *
 * Consome view `v_flex_opportunity` (criada no Bloco 2 / migration 20260549).
 * Vazzo hoje: 196 opportunities (items elegíveis sem ativação) + 47 não-elegíveis.
 *
 * Top 20 ordenado por visits_7d desc — items mais visitados primeiro
 * (maior potencial de impacto se ativar Flex).
 */

export interface FlexOpportunityCardData {
  summary: {
    totalEligible:      number
    activated:          number
    opportunity:        number
    notEligible:        number
    activationRate:     number    // activated / eligible * 100
    nullCoverage:       number    // is_active IS NULL
  }
  opportunityTopItems: Array<{
    ml_item_id:         string
    listing_title:      string | null
    visits_7d:          number
    coverage_pct:       number | null
    listing_permalink:  string | null
  }>
  lastSyncedAt:         string | null
}

@Injectable()
export class FlexOpportunityCardService {
  private readonly logger = new Logger(FlexOpportunityCardService.name)

  async getCard(orgId: string): Promise<FlexOpportunityCardData> {
    // 1. Counts por flex_state
    const { data: stateRows } = await supabaseAdmin
      .from('v_flex_opportunity')
      .select('flex_state, is_eligible, is_active')
      .eq('organization_id', orgId)
    const rows = (stateRows ?? []) as Array<{ flex_state: string; is_eligible: boolean; is_active: boolean | null }>

    const activated    = rows.filter(r => r.flex_state === 'active').length
    const opportunity  = rows.filter(r => r.flex_state === 'opportunity').length
    const notEligible  = rows.filter(r => r.flex_state === 'not_eligible').length
    const totalEligible = activated + opportunity
    const nullCoverage = rows.filter(r => r.is_eligible === true && r.is_active === null).length
    const activationRate = totalEligible > 0
      ? Math.round((activated / totalEligible) * 1000) / 10
      : 0

    // 2. Top 20 opportunities por visits_7d
    const { data: opps } = await supabaseAdmin
      .from('v_flex_opportunity')
      .select('ml_item_id, coverage_pct')
      .eq('organization_id', orgId)
      .eq('flex_state', 'opportunity')
    const oppRows = (opps ?? []) as Array<{ ml_item_id: string; coverage_pct: number | null }>
    const oppIds = oppRows.map(r => r.ml_item_id)

    // 3. Visits 7d (latest period_end)
    let visitsMap = new Map<string, number>()
    if (oppIds.length > 0) {
      const { data: visits } = await supabaseAdmin
        .from('ml_item_visits_period')
        .select('ml_item_id, total_visits, period_end')
        .eq('organization_id', orgId)
        .eq('period_days', 7)
        .in('ml_item_id', oppIds)
        .order('period_end', { ascending: false })
      // pick latest period_end per item
      const seen = new Set<string>()
      for (const v of ((visits ?? []) as Array<{ ml_item_id: string; total_visits: number; period_end: string }>)) {
        if (seen.has(v.ml_item_id)) continue
        seen.add(v.ml_item_id)
        visitsMap.set(v.ml_item_id, v.total_visits ?? 0)
      }
    }

    // 4. Listings (title + permalink)
    let listingsMap = new Map<string, { listing_title: string | null; listing_permalink: string | null }>()
    if (oppIds.length > 0) {
      const { data: listings } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id, listing_title, listing_permalink')
        .eq('platform', 'mercadolivre')
        .eq('is_active', true)
        .in('listing_id', oppIds)
      for (const l of ((listings ?? []) as Array<{ listing_id: string; listing_title: string | null; listing_permalink: string | null }>)) {
        listingsMap.set(l.listing_id, { listing_title: l.listing_title, listing_permalink: l.listing_permalink })
      }
    }

    // 5. Compor + sort por visits desc + top 20
    const enriched = oppRows
      .map(r => {
        const meta = listingsMap.get(r.ml_item_id) ?? { listing_title: null, listing_permalink: null }
        return {
          ml_item_id:        r.ml_item_id,
          listing_title:     meta.listing_title,
          visits_7d:         visitsMap.get(r.ml_item_id) ?? 0,
          coverage_pct:      r.coverage_pct,
          listing_permalink: meta.listing_permalink,
        }
      })
      .sort((a, b) => b.visits_7d - a.visits_7d)
      .slice(0, 20)

    // 6. lastSyncedAt — usa ml_flex_status.fetched_at mais recente
    const { data: lastSync } = await supabaseAdmin
      .from('ml_flex_status')
      .select('fetched_at')
      .eq('organization_id', orgId)
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastSyncedAt = (lastSync as { fetched_at: string } | null)?.fetched_at ?? null

    return {
      summary: {
        totalEligible, activated, opportunity, notEligible,
        activationRate, nullCoverage,
      },
      opportunityTopItems: enriched,
      lastSyncedAt,
    }
  }
}
