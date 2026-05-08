/** Read-only queries pro Quality Center (dashboard, items list, etc.). */

import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

interface ListItemsInput {
  orgId:          string
  sellerId?:      number
  level?:         'basic' | 'satisfactory' | 'professional'
  domainId?:      string
  hasPenalty?:    boolean
  minScore?:      number
  maxScore?:      number
  listingStatus?: 'active' | 'paused' | 'closed' | 'under_review'
  catalogOnly?:   boolean
  q?:             string
  limit?:         number
  offset?:        number
  sort?:          'priority' | 'score_asc' | 'score_desc' | 'recent'
}

@Injectable()
export class MlQualityService {
  /** Resumo executivo (org_summary). Quando sellerId omitido, agrega
   *  somando todas contas da org. */
  async getDashboard(orgId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_quality_org_summary')
      .select('*')
      .eq('organization_id', orgId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, error } = await q
    if (error) throw new BadRequestException(`dashboard: ${error.message}`)
    if (!data || data.length === 0) {
      return { total_items: 0, items_basic: 0, items_satisfactory: 0, items_professional: 0,
               items_complete: 0, items_incomplete: 0, items_with_penalty: 0,
               avg_score: 0, median_score: 0, total_pending_actions: 0,
               top_critical_domains: [], top_missing_attributes: [],
               quick_wins_count: 0, quick_wins_estimated_gain: 0,
               last_sync_at: null, sellers: [] }
    }
    if (sellerId != null) return data[0]

    // Agrega multi-conta
    const sum = (k: string) => data.reduce((s: number, d: any) => s + (Number(d[k]) || 0), 0)
    const total = sum('total_items')
    const avgWeighted = total > 0
      ? data.reduce((s, d: any) => s + ((d.avg_score ?? 0) * (d.total_items ?? 0)), 0) / total
      : 0
    return {
      total_items:                total,
      items_basic:                sum('items_basic'),
      items_satisfactory:         sum('items_satisfactory'),
      items_professional:         sum('items_professional'),
      items_complete:             sum('items_complete'),
      items_incomplete:           sum('items_incomplete'),
      items_with_penalty:         sum('items_with_penalty'),
      avg_score:                  Math.round(avgWeighted * 100) / 100,
      median_score:               null, // nao agrega median trivialmente
      total_pending_actions:      sum('total_pending_actions'),
      quick_wins_count:           sum('quick_wins_count'),
      quick_wins_estimated_gain:  sum('quick_wins_estimated_gain'),
      last_sync_at:               data.map((d: any) => d.last_sync_at).filter(Boolean).sort().pop() ?? null,
      sellers: data.map((d: any) => ({ seller_id: d.seller_id, total_items: d.total_items, avg_score: d.avg_score })),
    }
  }

  async listItems(input: ListItemsInput) {
    const limit  = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const offset = Math.max(input.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('ml_quality_snapshots')
      .select('*', { count: 'exact' })
      .eq('organization_id', input.orgId)
      .range(offset, offset + limit - 1)

    if (input.sellerId      != null) q = q.eq('seller_id', input.sellerId)
    if (input.level)                 q = q.eq('ml_level', input.level)
    if (input.domainId)              q = q.eq('ml_domain_id', input.domainId)
    if (input.hasPenalty    != null) q = q.eq('has_exposure_penalty', input.hasPenalty)
    if (input.minScore      != null) q = q.gte('ml_score', input.minScore)
    if (input.maxScore      != null) q = q.lte('ml_score', input.maxScore)
    if (input.listingStatus)         q = q.eq('listing_status', input.listingStatus)
    if (input.catalogOnly   === true) q = q.eq('catalog_listing', true)
    if (input.q?.trim())             q = q.ilike('ml_item_id', `%${input.q.trim()}%`)

    switch (input.sort ?? 'priority') {
      case 'priority':   q = q.order('internal_priority_score', { ascending: false, nullsFirst: false }); break
      case 'score_asc':  q = q.order('ml_score',                 { ascending: true,  nullsFirst: false }); break
      case 'score_desc': q = q.order('ml_score',                 { ascending: false, nullsFirst: false }); break
      case 'recent':     q = q.order('fetched_at',               { ascending: false }); break
    }

    const { data, count, error } = await q
    if (error) throw new BadRequestException(`listItems: ${error.message}`)
    return { items: data ?? [], total: count ?? 0 }
  }

  async getItem(orgId: string, mlItemId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_quality_snapshots')
      .select('*')
      .eq('organization_id', orgId)
      .eq('ml_item_id', mlItemId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q.maybeSingle()
    if (error) throw new BadRequestException(`getItem: ${error.message}`)
    return data
  }

  /** Anuncios proximos de 100% (90-99) ordenados por estimated gain desc. */
  async getQuickWins(orgId: string, sellerId?: number, limit = 50) {
    let q = supabaseAdmin
      .from('ml_quality_snapshots')
      .select('*')
      .eq('organization_id', orgId)
      .gte('ml_score', 90)
      .lt('ml_score', 100)
      .order('internal_priority_score', { ascending: false, nullsFirst: false })
      .limit(limit)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`quickWins: ${error.message}`)
    return data ?? []
  }

  async getPenalties(orgId: string, sellerId?: number, limit = 100) {
    let q = supabaseAdmin
      .from('ml_quality_snapshots')
      .select('*')
      .eq('organization_id', orgId)
      .eq('has_exposure_penalty', true)
      .order('ml_score', { ascending: true, nullsFirst: false })
      .limit(limit)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`penalties: ${error.message}`)
    return data ?? []
  }

  async getCategories(orgId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_domain_id, ml_score, ml_level')
      .eq('organization_id', orgId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`categories: ${error.message}`)

    const agg = new Map<string, { domain_id: string; total: number; basic: number; satisfactory: number; professional: number; sumScore: number }>()
    for (const r of (data ?? []) as any[]) {
      const d = r.ml_domain_id ?? 'unknown'
      const cur = agg.get(d) ?? { domain_id: d, total: 0, basic: 0, satisfactory: 0, professional: 0, sumScore: 0 }
      cur.total++
      if (r.ml_level === 'basic')        cur.basic++
      if (r.ml_level === 'satisfactory') cur.satisfactory++
      if (r.ml_level === 'professional') cur.professional++
      cur.sumScore += r.ml_score ?? 0
      agg.set(d, cur)
    }
    return Array.from(agg.values())
      .map(c => ({ ...c, avg_score: c.total > 0 ? Math.round(c.sumScore / c.total) : 0 }))
      .sort((a, b) => b.total - a.total)
  }

  /** Score history pra grafico de evolucao de UM item. */
  async getItemHistory(orgId: string, mlItemId: string, sellerId?: number, days = 90) {
    const fromDate = new Date(Date.now() - days * 86400_000).toISOString()
    let q = supabaseAdmin
      .from('ml_quality_score_history')
      .select('captured_at, ml_score, ml_level, pi_complete, ft_complete, all_complete')
      .eq('organization_id', orgId)
      .eq('ml_item_id', mlItemId)
      .gte('captured_at', fromDate)
      .order('captured_at', { ascending: true })
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`itemHistory: ${error.message}`)
    return data ?? []
  }

  /** Ultimos sync logs. */
  async getSyncLogs(orgId: string, limit = 20) {
    const { data, error } = await supabaseAdmin
      .from('ml_quality_sync_logs')
      .select('*')
      .eq('organization_id', orgId)
      .order('started_at', { ascending: false })
      .limit(limit)
    if (error) throw new BadRequestException(`syncLogs: ${error.message}`)
    return data ?? []
  }
}
