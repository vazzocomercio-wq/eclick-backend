/** Read-only queries pro Campaign Center (dashboard, listas, detalhes). */

import { Injectable, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/** Calcula M.C.% final pra uma recomendação considerando o cost_breakdown
 *  do snapshot (ja inclui custo + imposto + comissão + frete + embalagem +
 *  operacional − subsídio MELI) e o preço final escolhido (que pode ser o
 *  recomendado ou o editado pelo operador). */
function computeFinalMarginPct(reco: { cost_breakdown?: Record<string, number> | null; recommended_strategy?: string | null; scenarios?: Record<string, unknown> | null }, finalPrice: number | null | undefined): number {
  if (finalPrice == null || finalPrice <= 0) return 0

  // Preferir total_costs do cost_breakdown (snapshot canônico).
  const cb = reco.cost_breakdown ?? {}
  const totalCosts = Number(cb.total_costs ?? 0)
  if (totalCosts > 0) {
    return ((finalPrice - totalCosts) / finalPrice) * 100
  }

  // Fallback: se não tiver total_costs, usar margem da estratégia escolhida
  const strat = reco.recommended_strategy
  const sc = (reco.scenarios ?? {}) as Record<string, { margin_pct?: number; price?: number }>
  if (strat && sc[strat]?.margin_pct != null) {
    return Number(sc[strat]!.margin_pct)
  }
  // último fallback: competitive
  if (sc.competitive?.margin_pct != null) return Number(sc.competitive.margin_pct)
  return 0
}

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
  orgId:          string
  sellerId?:      number
  campaignId?:    string                // uuid da row ml_campaigns
  status?:        'candidate' | 'pending' | 'started' | 'finished'
  healthStatus?:  'ready' | 'missing_cost' | 'missing_tax' | 'missing_shipping' | 'incomplete'
  hasSubsidy?:    boolean
  /** Filtro pelo status do anúncio na ML (não da campanha). */
  listingStatus?: 'active' | 'paused' | 'closed' | 'under_review'
  /** Filtro só catálogo (compete por buy box). */
  catalogListing?: boolean
  q?:           string                 // busca por ml_item_id
  limit?:       number
  offset?:      number
}

@Injectable()
export class MlCampaignsService {
  /** Dashboard executivo — agrega summary multi-conta.
   *  GRACEFUL DEGRADATION: erro nunca propaga 500. Loga e retorna
   *  emptyDashboard() pra UI carregar mostrando "nenhuma campanha". */
  async getDashboard(orgId: string, sellerId?: number) {
    try {
      let q = supabaseAdmin
        .from('ml_campaigns_summary')
        .select('*')
        .eq('organization_id', orgId)
      if (sellerId != null) q = q.eq('seller_id', sellerId)

      const { data, error } = await q
      if (error) {
        console.error('[ml-campaigns:dashboard] query error:', error)
        return this.emptyDashboard()
      }
      if (!data || data.length === 0) {
        return this.emptyDashboard()
      }
      if (sellerId != null) return data[0]

      return this.aggregate(data)
    } catch (e) {
      console.error('[ml-campaigns:dashboard] unhandled:', e)
      return this.emptyDashboard()
    }
  }

  private aggregate(data: any[]) {

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

    if (input.sellerId   != null)    q = q.eq('seller_id',         input.sellerId)
    if (input.campaignId)            q = q.eq('campaign_id',       input.campaignId)
    if (input.status)                q = q.eq('status',            input.status)
    if (input.healthStatus)          q = q.eq('health_status',     input.healthStatus)
    if (input.hasSubsidy != null)    q = q.eq('has_meli_subsidy',  input.hasSubsidy)
    if (input.listingStatus)         q = q.eq('listing_status',    input.listingStatus)
    if (input.catalogListing != null) q = q.eq('catalog_listing',  input.catalogListing)
    if (input.q?.trim())             q = q.ilike('ml_item_id', `%${input.q.trim()}%`)

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

  /** Aprova uma recomendação aplicando o soft gate de margem.
   *  Fluxo:
   *   1. Lê recomendação + config + tipo de campanha
   *   2. Calcula margem da estratégia escolhida (ou da editada, se operador
   *      mudou preço, recalcula em cima dos custos do snapshot)
   *   3. Threshold = per_campaign_type_overrides[type] ?? min_approval_margin_pct
   *   4. Se margem >= threshold → status='approved'/'edited'
   *   5. Se margem  < threshold → status='pending_manager_approval' + log
   *      em ml_campaign_approval_attempts, dispara alerta gestor se passar
   *      do audit_attempts_threshold em 30d.
   *  Retorna { recommendation, gate_triggered, threshold_pct, attempted_margin_pct,
   *           recent_attempts_count? } pra UI mostrar feedback. */
  async approveRecommendation(orgId: string, id: string, userId: string, edited?: { price?: number; quantity?: number }) {
    // 1. Lê recomendação com tipo de campanha
    const { data: reco, error: rErr } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('*, ml_campaigns:campaign_id(ml_promotion_type)')
      .eq('organization_id', orgId)
      .eq('id', id)
      .single()
    if (rErr || !reco) throw new BadRequestException(`approve: recomendação não encontrada`)
    if (reco.status !== 'pending') {
      throw new BadRequestException(`approve: recomendação está em status ${reco.status}, esperado pending`)
    }

    // 2. Lê config (cria default se não existe)
    const config = await this.getConfig(orgId, reco.seller_id)

    // 3. Determina margem efetiva
    const finalPrice    = edited?.price ?? reco.recommended_price
    const finalQuantity = edited?.quantity ?? reco.recommended_quantity
    const attemptedMargin = computeFinalMarginPct(reco, finalPrice)

    // 4. Determina threshold (overrride por tipo se existir)
    const campaignType: string | undefined = (reco as { ml_campaigns?: { ml_promotion_type?: string } })
      .ml_campaigns?.ml_promotion_type
    const overrides = (config.per_campaign_type_overrides ?? {}) as Record<string, number>
    const threshold = (campaignType && overrides[campaignType] != null)
      ? Number(overrides[campaignType])
      : Number(config.min_approval_margin_pct ?? 10)

    const newStatus: string = (attemptedMargin >= threshold)
      ? (edited ? 'edited' : 'approved')
      : 'pending_manager_approval'

    const update: Record<string, unknown> = {
      status:               newStatus,
      reviewed_at:          new Date().toISOString(),
      reviewed_by:          userId,
      attempted_margin_pct: attemptedMargin,
      gate_threshold_pct:   threshold,
    }
    if (edited?.price    != null) update.recommended_price    = finalPrice
    if (edited?.quantity != null) update.recommended_quantity = finalQuantity

    const { data: updated, error: uErr } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .update(update)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (uErr) throw new BadRequestException(`approve: ${uErr.message}`)

    let recentAttemptsCount: number | undefined
    if (newStatus === 'pending_manager_approval') {
      // Log da tentativa
      await supabaseAdmin
        .from('ml_campaign_approval_attempts')
        .insert({
          organization_id:      orgId,
          seller_id:            reco.seller_id,
          recommendation_id:    id,
          operator_user_id:     userId,
          attempted_margin_pct: attemptedMargin,
          threshold_pct:        threshold,
          campaign_type:        campaignType ?? null,
          outcome:              'sent_to_manager',
        })

      // Conta tentativas do operador nos últimos 30 dias
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
      const { count } = await supabaseAdmin
        .from('ml_campaign_approval_attempts')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .eq('operator_user_id', userId)
        .gte('created_at', thirtyDaysAgo)
      recentAttemptsCount = count ?? 0
    }

    return {
      recommendation:        updated,
      gate_triggered:        newStatus === 'pending_manager_approval',
      attempted_margin_pct:  attemptedMargin,
      threshold_pct:         threshold,
      campaign_type:         campaignType,
      recent_attempts_count: recentAttemptsCount,
      audit_threshold:       Number(config.audit_attempts_threshold ?? 5),
    }
  }

  /** Gestor aprova uma recomendação que está em pending_manager_approval.
   *  Logs override no audit + libera pra apply. */
  async managerApproveRecommendation(orgId: string, id: string, managerUserId: string, reason?: string) {
    const { data: reco, error: rErr } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .single()
    if (rErr || !reco) throw new BadRequestException(`manager-approve: não encontrada`)
    if (reco.status !== 'pending_manager_approval') {
      throw new BadRequestException(`manager-approve: status atual é ${reco.status}, esperado pending_manager_approval`)
    }

    const { data: updated, error: uErr } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .update({
        status:                  'manager_approved',
        manager_decided_by:      managerUserId,
        manager_decided_at:      new Date().toISOString(),
        manager_decision_reason: reason ?? null,
      })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (uErr) throw new BadRequestException(`manager-approve: ${uErr.message}`)

    // Atualiza última tentativa (se existir) com outcome=manager_approved
    await supabaseAdmin
      .from('ml_campaign_approval_attempts')
      .update({ outcome: 'manager_approved' })
      .eq('recommendation_id', id)
      .eq('outcome', 'sent_to_manager')

    return updated
  }

  /** Gestor rejeita override. Recomendação fica como rejected_by_manager. */
  async managerRejectRecommendation(orgId: string, id: string, managerUserId: string, reason?: string) {
    const { data: reco, error: rErr } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .single()
    if (rErr || !reco) throw new BadRequestException(`manager-reject: não encontrada`)
    if (reco.status !== 'pending_manager_approval') {
      throw new BadRequestException(`manager-reject: status atual é ${reco.status}, esperado pending_manager_approval`)
    }

    const { data: updated, error: uErr } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .update({
        status:                  'rejected_by_manager',
        manager_decided_by:      managerUserId,
        manager_decided_at:      new Date().toISOString(),
        manager_decision_reason: reason ?? null,
      })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .single()
    if (uErr) throw new BadRequestException(`manager-reject: ${uErr.message}`)

    await supabaseAdmin
      .from('ml_campaign_approval_attempts')
      .update({ outcome: 'manager_rejected' })
      .eq('recommendation_id', id)
      .eq('outcome', 'sent_to_manager')

    return updated
  }

  /** Lista recomendações na fila do gestor (status=pending_manager_approval). */
  async listManagerQueue(orgId: string, sellerId?: number, limit = 50, offset = 0) {
    let q = supabaseAdmin
      .from('ml_campaign_recommendations')
      .select('*, ml_campaign_items(ml_item_id, original_price, current_price, thumbnail_url, title), ml_campaigns:campaign_id(name, ml_promotion_type, deadline_date)', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('status', 'pending_manager_approval')
      .order('reviewed_at', { ascending: true })
      .range(offset, offset + limit - 1)
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, count, error } = await q
    if (error) throw new BadRequestException(`listManagerQueue: ${error.message}`)
    return { recommendations: data ?? [], total: count ?? 0 }
  }

  /** Audit: tentativas de aprovar abaixo do gate por operador (últimos 30d).
   *  Útil pro gestor entender padrão antes de aprovar/rejeitar. */
  async getAuditOperatorAttempts(orgId: string, operatorUserId: string) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_approval_attempts')
      .select('*')
      .eq('organization_id', orgId)
      .eq('operator_user_id', operatorUserId)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(100)
    if (error) throw new BadRequestException(`audit: ${error.message}`)
    return data ?? []
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
      // M1 — operação humana + soft gate
      'assignee_user_id', 'notification_phone',
      'manager_user_id', 'manager_whatsapp_phone',
      'min_approval_margin_pct', 'per_campaign_type_overrides',
      'deadline_alert_days_before', 'whatsapp_alerts_enabled', 'escalate_alerts',
      'auto_alert_when_subsidy_above_pct', 'audit_attempts_threshold',
      // M4 — Active integration (cards + tasks)
      'active_org_id',
      'active_pipeline_id', 'active_stage_initial_id',
      'active_stage_pending_manager_id', 'active_stage_in_campaign_id',
      'active_assigned_to',
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
