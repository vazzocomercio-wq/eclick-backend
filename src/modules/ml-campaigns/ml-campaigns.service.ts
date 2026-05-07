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

  // ═══ Camada 2: Recommendations + Config ═════════════════════════

  async listRecommendations(input: {
    orgId:           string
    sellerId?:       number
    classification?: string
    status?:         string
    minScore?:       number
    campaignId?:     string
    limit?:          number
    offset?:         number
  }) {
    const limit  = Math.min(Math.max(input.limit ?? 50, 1), 500)
    const offset = Math.max(input.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('*, ml_campaign_items!inner(ml_item_id, ml_campaign_id, original_price, current_price, status), ml_campaigns(name, ml_promotion_type, deadline_date, has_subsidy_items)', { count: 'exact' })
      .eq('organization_id', input.orgId)
      .range(offset, offset + limit - 1)
      .order('opportunity_score', { ascending: false })

    if (input.sellerId       != null) q = q.eq('seller_id', input.sellerId)
    if (input.classification)         q = q.eq('recommendation', input.classification)
    if (input.status)                 q = q.eq('status', input.status)
    if (input.minScore       != null) q = q.gte('opportunity_score', input.minScore)
    if (input.campaignId)             q = q.eq('ml_campaign_items.campaign_id', input.campaignId)

    const { data, count, error } = await q
    if (error) throw new BadRequestException(`listRecommendations: ${error.message}`)
    return { recommendations: data ?? [], total: count ?? 0 }
  }

  async getRecommendation(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('*, ml_campaign_items(*, ml_campaigns(*))')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`getRecommendation: ${error.message}`)
    return data
  }

  async approveRecommendation(orgId: string, id: string, userId: string, edited?: { price?: number; quantity?: number }) {
    const update: Record<string, unknown> = {
      status:      edited ? 'edited' : 'approved',
      reviewed_at: new Date().toISOString(),
      reviewed_by: userId,
    }
    if (edited?.price    != null) update.recommended_price    = edited.price
    if (edited?.quantity != null) update.recommended_quantity = edited.quantity

    const { data, error } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`approve: ${error.message}`)
    return data
  }

  async rejectRecommendation(orgId: string, id: string, userId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: userId })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (error) throw new BadRequestException(`reject: ${error.message}`)
    return data
  }

  // ── Config ──────────────────────────────────────────────────────

  async getConfig(orgId: string, sellerId: number) {
    const { data } = await supabaseAdmin
      .from('ml_campaigns_config')
      .select('*')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .maybeSingle()
    if (data) return data
    // Cria default se nao existe
    const { data: created, error } = await supabaseAdmin
      .from('ml_campaigns_config')
      .insert({ organization_id: orgId, seller_id: sellerId })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`getConfig: ${error.message}`)
    return created
  }

  async updateConfig(orgId: string, sellerId: number, patch: Record<string, unknown>) {
    // Defensive: rejeitar campos nao permitidos
    const allowed = [
      'min_acceptable_margin_pct', 'target_margin_pct', 'clearance_min_margin_pct',
      'safety_stock_days', 'high_stock_threshold_days', 'min_stock_to_participate',
      'quality_gate_enabled', 'quality_gate_min_score',
      'default_packaging_cost', 'default_operational_cost_pct',
      'ai_daily_cap_usd', 'ai_alert_at_pct', 'ai_reasoning_enabled',
      'auto_suggest_on_new_candidate', 'daily_analysis_enabled',
      'auto_approve_enabled', 'auto_approve_score_above',
    ]
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]

    // Upsert (cria se nao existe)
    const { data, error } = await supabaseAdmin
      .from('ml_campaigns_config')
      .upsert({ organization_id: orgId, seller_id: sellerId, ...safe }, { onConflict: 'organization_id,seller_id' })
      .select('*')
      .single()
    if (error) throw new BadRequestException(`updateConfig: ${error.message}`)
    return data
  }

  // ── AI usage (cap diario) ──────────────────────────────────────

  async getAiUsageToday(orgId: string): Promise<{ cost_usd: number; calls: number; cap_usd: number; pct_used: number }> {
    // Cap atual da org (qualquer config — usa o maior cap entre sellers)
    const { data: configs } = await supabaseAdmin
      .from('ml_campaigns_config')
      .select('ai_daily_cap_usd')
      .eq('organization_id', orgId)
    const cap = Math.max(10, ...((configs ?? []) as Array<{ ai_daily_cap_usd: number }>).map(c => c.ai_daily_cap_usd))

    // Total gasto hoje (00:00 UTC ate agora)
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const { data: logs } = await supabaseAdmin
      .from('ml_campaigns_ai_usage_log')
      .select('cost_usd')
      .eq('organization_id', orgId)
      .gte('created_at', todayStart.toISOString())
    const totalCost = ((logs ?? []) as Array<{ cost_usd: number }>).reduce((s, l) => s + (l.cost_usd ?? 0), 0)
    const calls = (logs ?? []).length
    return {
      cost_usd:  Number(totalCost.toFixed(4)),
      calls,
      cap_usd:   cap,
      pct_used:  cap > 0 ? Math.round((totalCost / cap) * 100) : 0,
    }
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
