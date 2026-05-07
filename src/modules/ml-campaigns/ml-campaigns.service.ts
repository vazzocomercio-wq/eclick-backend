/** Read-only queries pro Campaign Center (dashboard, listas, detalhes). */

import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

interface ListCampaignsInput {
  orgId:     string
  sellerId?: number
  status?:   'pending' | 'started' | 'finished' | 'paused' | 'expired'
  type?:     string
  hasSubsidy?:    boolean
  endingInDays?:  number
  limit?:    number
  offset?:   number
}

interface ListItemsInput {
  orgId:        string
  sellerId?:    number
  campaignId?:  string                // uuid da row ml_campaigns
  status?:      'candidate' | 'pending' | 'started' | 'finished'
  healthStatus?: 'ready' | 'missing_cost' | 'missing_tax' | 'missing_shipping' | 'incomplete'
  hasSubsidy?:  boolean
  q?:           string                 // busca por ml_item_id
  limit?:       number
  offset?:      number
}

@Injectable()
export class MlCampaignsService {
  /** Dashboard executivo — agrega summary multi-conta. */
  async getDashboard(orgId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_campaigns_summary')
      .select('*')
      .eq('organization_id', orgId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, error } = await q
    if (error) throw new BadRequestException(`dashboard: ${error.message}`)
    if (!data || data.length === 0) {
      return this.emptyDashboard()
    }
    if (sellerId != null) return data[0]

    // Agrega multi-conta
    const sum = (k: string) => data.reduce((s: number, d: any) => s + (Number(d[k]) || 0), 0)
    return {
      total_active_campaigns:        sum('total_active_campaigns'),
      total_pending_campaigns:       sum('total_pending_campaigns'),
      total_ending_today:            sum('total_ending_today'),
      total_ending_this_week:        sum('total_ending_this_week'),
      total_candidate_items:         sum('total_candidate_items'),
      total_pending_items:           sum('total_pending_items'),
      total_participating_items:     sum('total_participating_items'),
      items_missing_cost:            sum('items_missing_cost'),
      items_missing_tax:             sum('items_missing_tax'),
      items_health_ok:               sum('items_health_ok'),
      total_meli_subsidy_available:  sum('total_meli_subsidy_available'),
      last_sync_at:                  data.map((d: any) => d.last_sync_at).filter(Boolean).sort().pop() ?? null,
      sellers: data.map((d: any) => ({
        seller_id:                d.seller_id,
        active_campaigns:         d.total_active_campaigns,
        candidate_items:          d.total_candidate_items,
        participating_items:      d.total_participating_items,
      })),
    }
  }

  async listCampaigns(input: ListCampaignsInput) {
    const limit  = Math.min(Math.max(input.limit ?? 100, 1), 500)
    const offset = Math.max(input.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('ml_campaigns')
      .select('*', { count: 'exact' })
      .eq('organization_id', input.orgId)
      .range(offset, offset + limit - 1)
      .order('deadline_date', { ascending: true, nullsFirst: false })

    if (input.sellerId   != null) q = q.eq('seller_id',         input.sellerId)
    if (input.status)             q = q.eq('status',            input.status)
    if (input.type)               q = q.eq('ml_promotion_type', input.type)
    if (input.hasSubsidy != null) q = q.eq('has_subsidy_items', input.hasSubsidy)
    if (input.endingInDays != null) {
      const cutoff = new Date(Date.now() + input.endingInDays * 86_400_000).toISOString()
      q = q.lte('deadline_date', cutoff).not('deadline_date', 'is', null)
    }

    const { data, count, error } = await q
    if (error) throw new BadRequestException(`listCampaigns: ${error.message}`)
    return { campaigns: data ?? [], total: count ?? 0 }
  }

  async getCampaign(orgId: string, campaignId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaigns')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', campaignId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getCampaign: ${error.message}`)
    return data
  }

  async listItems(input: ListItemsInput) {
    const limit  = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const offset = Math.max(input.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('ml_campaign_items')
      .select('*', { count: 'exact' })
      .eq('organization_id', input.orgId)
      .range(offset, offset + limit - 1)
      .order('updated_at', { ascending: false })

    if (input.sellerId   != null) q = q.eq('seller_id',     input.sellerId)
    if (input.campaignId)         q = q.eq('campaign_id',   input.campaignId)
    if (input.status)             q = q.eq('status',        input.status)
    if (input.healthStatus)       q = q.eq('health_status', input.healthStatus)
    if (input.hasSubsidy != null) q = q.eq('has_meli_subsidy', input.hasSubsidy)
    if (input.q?.trim())          q = q.ilike('ml_item_id', `%${input.q.trim()}%`)

    const { data, count, error } = await q
    if (error) throw new BadRequestException(`listItems: ${error.message}`)
    return { items: data ?? [], total: count ?? 0 }
  }

  /** Items missing data (health check) — atalho pro dashboard "12 anuncios sem custo". */
  async getMissingDataItems(orgId: string, sellerId?: number, limit = 100) {
    let q = supabaseAdmin
      .from('ml_campaign_items')
      .select('id, ml_item_id, product_id, health_status, health_warnings, ml_campaign_id, status')
      .eq('organization_id', orgId)
      .neq('health_status', 'ready')
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, error } = await q
    if (error) throw new BadRequestException(`getMissingDataItems: ${error.message}`)
    return data ?? []
  }

  /** Campanhas encerrando — pra alerta de prazo. */
  async getDeadlines(orgId: string, sellerId?: number, daysAhead = 7) {
    const cutoff = new Date(Date.now() + daysAhead * 86_400_000).toISOString()
    let q = supabaseAdmin
      .from('ml_campaigns')
      .select('*')
      .eq('organization_id', orgId)
      .in('status', ['pending', 'started'])
      .not('deadline_date', 'is', null)
      .lte('deadline_date', cutoff)
      .order('deadline_date', { ascending: true })
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, error } = await q
    if (error) throw new BadRequestException(`getDeadlines: ${error.message}`)
    return data ?? []
  }

  /** Promocoes elegiveis pra 1 item (1 anuncio pode estar em N campanhas). */
  async getItemPromotions(orgId: string, mlItemId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_campaign_items')
      .select('*, ml_campaigns!inner(name, ml_promotion_type, status, deadline_date, finish_date)')
      .eq('organization_id', orgId)
      .eq('ml_item_id', mlItemId)
      .order('updated_at', { ascending: false })
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, error } = await q
    if (error) throw new BadRequestException(`getItemPromotions: ${error.message}`)
    return data ?? []
  }

  /** Logs de sync pra debug. */
  async getSyncLogs(orgId: string, limit = 20) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaigns_sync_logs')
      .select('*')
      .eq('organization_id', orgId)
      .order('started_at', { ascending: false })
      .limit(limit)
    if (error) throw new BadRequestException(`getSyncLogs: ${error.message}`)
    return data ?? []
  }

  private emptyDashboard() {
    return {
      total_active_campaigns: 0, total_pending_campaigns: 0,
      total_ending_today: 0, total_ending_this_week: 0,
      total_candidate_items: 0, total_pending_items: 0, total_participating_items: 0,
      items_missing_cost: 0, items_missing_tax: 0, items_health_ok: 0,
      total_meli_subsidy_available: 0,
      last_sync_at: null,
      sellers: [],
    }
  }
}
