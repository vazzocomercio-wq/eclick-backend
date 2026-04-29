import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

/** Service dedicado ao painel unificado /dashboard/enriquecimento (Sprint
 * ENRICH-HUB-1). Concentra os endpoints novos do dashboard: KPIs,
 * timeseries, recent failures, queue stats, settings (auto-enabled +
 * post-enrich delay), e CRUD do template post-enrichment.
 *
 * Não duplica lógica de enrich/route/test (que vivem em EnrichmentService,
 * RoutingService, CostTrackerService) — só lê/grava as agregações e
 * settings. Reutiliza supabaseAdmin direto pra evitar acoplamento. */
@Injectable()
export class EnrichmentHubService {
  private readonly logger = new Logger(EnrichmentHubService.name)

  // ── Dashboard KPIs ──────────────────────────────────────────────────────

  /** GET /enrichment/dashboard/kpis — 4 números pro topo do painel:
   * enriquecidos (full+partial / total), success rate 30d, cost MTD vs
   * budget, pending count. */
  async getKpis(orgId: string): Promise<{
    enriched_full:     number
    enriched_partial:  number
    total:             number
    success_rate_30d:  number
    cost_mtd_brl:      number
    budget_total_brl:  number
    pending_count:     number
  }> {
    // 1. Distribuição de enrichment_status na org
    const { data: customers } = await supabaseAdmin
      .from('unified_customers')
      .select('enrichment_status')
      .eq('organization_id', orgId)
      .eq('is_deleted', false)

    let full = 0, partial = 0, pending = 0
    const all = (customers ?? []) as Array<{ enrichment_status: string | null }>
    for (const c of all) {
      const s = c.enrichment_status
      if (s === 'full')                    full++
      else if (s === 'partial')            partial++
      else if (s === 'pending' || s === null) pending++
    }

    // 2. Success rate dos últimos 30 dias
    const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: logs } = await supabaseAdmin
      .from('enrichment_log')
      .select('final_status')
      .eq('organization_id', orgId)
      .gte('created_at', since30d)
      .limit(5000)
    const logRows = (logs ?? []) as Array<{ final_status: string }>
    const successCount = logRows.filter(l => ['success', 'partial', 'cached'].includes(l.final_status)).length
    const successRate = logRows.length > 0 ? successCount / logRows.length : 0

    // 3. Budget — soma monthly_budget_brl + monthly_spent_brl dos providers
    const { data: providers } = await supabaseAdmin
      .from('enrichment_providers')
      .select('monthly_budget_brl, monthly_spent_brl')
      .eq('organization_id', orgId)
      .eq('is_enabled', true)
    const provRows = (providers ?? []) as Array<{ monthly_budget_brl: number | null; monthly_spent_brl: number | null }>
    const budget = provRows.reduce((s, p) => s + Number(p.monthly_budget_brl ?? 0), 0)
    const spent  = provRows.reduce((s, p) => s + Number(p.monthly_spent_brl  ?? 0), 0)

    return {
      enriched_full:    full,
      enriched_partial: partial,
      total:            all.length,
      success_rate_30d: successRate,
      cost_mtd_brl:     spent,
      budget_total_brl: budget,
      pending_count:    pending,
    }
  }

  // ── Timeseries ──────────────────────────────────────────────────────────

  /** GET /enrichment/dashboard/timeseries?days=30 — chamadas por dia,
   * empilhadas por provider + status. Front decide como exibir (linhas
   * de success x failed, ou stacked bar por provider). */
  async getTimeseries(orgId: string, days: number): Promise<Array<{
    date:        string
    success:     number
    failed:      number
    by_provider: Record<string, number>
  }>> {
    const cap = Math.min(Math.max(days, 1), 90)
    const since = new Date(Date.now() - cap * 86_400_000).toISOString()

    const { data: rows } = await supabaseAdmin
      .from('enrichment_log')
      .select('final_status, final_provider, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', since)
      .limit(20_000)

    const map = new Map<string, { success: number; failed: number; by_provider: Record<string, number> }>()
    for (const r of (rows ?? []) as Array<{ final_status: string; final_provider: string | null; created_at: string }>) {
      const day = (r.created_at ?? '').slice(0, 10)
      if (!day) continue
      const cur = map.get(day) ?? { success: 0, failed: 0, by_provider: {} }
      const isSuccess = ['success', 'partial', 'cached'].includes(r.final_status)
      if (isSuccess) cur.success++
      else           cur.failed++
      const prov = r.final_provider ?? 'none'
      cur.by_provider[prov] = (cur.by_provider[prov] ?? 0) + 1
      map.set(day, cur)
    }

    // Preenche dias zerados pra UI não ter buracos no gráfico
    const out: Array<{ date: string; success: number; failed: number; by_provider: Record<string, number> }> = []
    for (let i = cap - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      const v = map.get(d) ?? { success: 0, failed: 0, by_provider: {} }
      out.push({ date: d, ...v })
    }
    return out
  }

  // ── Recent failures ─────────────────────────────────────────────────────

  /** GET /enrichment/recent-failures?limit=20 — join enrichment_log +
   * unified_customers pra mostrar nome + erro + provider tentado.
   * Faz fetch separado de customers (sem PostgREST embed) pra evitar
   * RLS surprises e funciona mesmo se o customer foi soft-deleted. */
  async getRecentFailures(orgId: string, limit: number): Promise<Array<{
    log_id:        string
    customer_id:   string | null
    customer_name: string | null
    cpf:           string | null
    provider:      string | null
    final_status:  string
    error_reason:  string         // categoriza: no_consent / no_credit / api_error / not_found
    last_error:    string         // mensagem raw mais útil
    created_at:    string
  }>> {
    const cap = Math.min(Math.max(limit, 1), 50)

    const { data: logs } = await supabaseAdmin
      .from('enrichment_log')
      .select('id, customer_id, final_provider, final_status, provider_attempts, created_at')
      .eq('organization_id', orgId)
      .in('final_status', ['failed', 'rate_limited', 'no_credit'])
      .order('created_at', { ascending: false })
      .limit(cap)

    const logRows = (logs ?? []) as Array<{
      id: string; customer_id: string | null; final_provider: string | null;
      final_status: string; provider_attempts: unknown; created_at: string
    }>
    if (logRows.length === 0) return []

    const customerIds = [...new Set(logRows.map(l => l.customer_id).filter((id): id is string => !!id))]
    const customerMap = new Map<string, { display_name: string | null; cpf: string | null }>()
    if (customerIds.length > 0) {
      const { data: customers } = await supabaseAdmin
        .from('unified_customers')
        .select('id, display_name, cpf')
        .in('id', customerIds)
      for (const c of (customers ?? []) as Array<{ id: string; display_name: string | null; cpf: string | null }>) {
        customerMap.set(c.id, { display_name: c.display_name, cpf: c.cpf })
      }
    }

    return logRows.map(l => {
      const attempts = Array.isArray(l.provider_attempts) ? l.provider_attempts as Array<{ provider?: string; status?: string; error?: string }> : []
      let lastErr = ''
      for (let i = attempts.length - 1; i >= 0; i--) {
        if (attempts[i]?.error) { lastErr = attempts[i].error!; break }
      }
      const reason = this.categorizeError(l.final_status, lastErr)
      const c = l.customer_id ? customerMap.get(l.customer_id) : null
      return {
        log_id:        l.id,
        customer_id:   l.customer_id,
        customer_name: c?.display_name ?? null,
        cpf:           c?.cpf ?? null,
        provider:      l.final_provider,
        final_status:  l.final_status,
        error_reason:  reason,
        last_error:    lastErr,
        created_at:    l.created_at,
      }
    })
  }

  /** Categorização barata pra filtro "por motivo" no painel. */
  private categorizeError(finalStatus: string, errMsg: string): string {
    if (finalStatus === 'no_credit')        return 'no_credit'
    if (finalStatus === 'rate_limited')     return 'rate_limited'
    const m = (errMsg ?? '').toLowerCase()
    if (m.includes('consent') || m === 'no_consent') return 'no_consent'
    if (m.includes('not found') || m.includes('404')) return 'not_found'
    if (m.includes('credit') || m.includes('saldo'))  return 'no_credit'
    return 'api_error'
  }

  // ── Queue stats ─────────────────────────────────────────────────────────

  /** GET /enrichment/queue-stats — usado pela aba "Disparo em massa".
   * Conta pending + failed e estima custo (usa cost_per_query_cents do
   * primary_provider de CPF, ou R$0.40 default se não houver). */
  async getQueueStats(orgId: string): Promise<{
    pending:        number
    failed:         number
    total_eligible: number
    estimated_cost: number  // BRL pra processar todos os elegíveis
  }> {
    // Pending: enrichment_status null OU pending, com algum identifier
    const { count: pendingCount } = await supabaseAdmin
      .from('unified_customers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .or('enrichment_status.is.null,enrichment_status.eq.pending')
      .not('cpf', 'is', null)

    // Failed: tentaram e não tiveram sucesso
    const { count: failedCount } = await supabaseAdmin
      .from('unified_customers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .eq('enrichment_status', 'failed')

    // Custo estimado por query — pega do primary_provider de cpf, ou R$0.40 fallback
    const { data: route } = await supabaseAdmin
      .from('enrichment_routing')
      .select('primary_provider')
      .eq('organization_id', orgId)
      .eq('query_type', 'cpf')
      .maybeSingle()

    let costPerQueryBrl = 0.40
    if (route?.primary_provider) {
      const { data: prov } = await supabaseAdmin
        .from('enrichment_providers')
        .select('cost_per_query_cents')
        .eq('organization_id', orgId)
        .eq('provider_code', route.primary_provider as string)
        .maybeSingle()
      const cents = Number(prov?.cost_per_query_cents ?? 0)
      if (cents > 0) costPerQueryBrl = cents / 100
    }

    const total = (pendingCount ?? 0) + (failedCount ?? 0)
    return {
      pending:        pendingCount ?? 0,
      failed:         failedCount  ?? 0,
      total_eligible: total,
      estimated_cost: Math.round(total * costPerQueryBrl * 100) / 100,
    }
  }

  // ── Settings (auto-enabled + post_enrich_delay) ─────────────────────────

  /** GET /enrichment/auto-enabled. Retorna a config atual da org. Se a
   * coluna não existir (migration não rodada), responde os defaults pra
   * UI não quebrar. */
  async getSettings(orgId: string): Promise<{
    auto_enrichment_enabled:   boolean
    post_enrich_delay_minutes: number
  }> {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('auto_enrichment_enabled, post_enrich_delay_minutes')
      .eq('id', orgId)
      .maybeSingle()
    if (error || !data) {
      this.logger.warn(`[hub.getSettings] org=${orgId} fallback defaults: ${error?.message ?? 'no row'}`)
      return { auto_enrichment_enabled: true, post_enrich_delay_minutes: 5 }
    }
    return {
      auto_enrichment_enabled:   (data as { auto_enrichment_enabled?: boolean }).auto_enrichment_enabled   ?? true,
      post_enrich_delay_minutes: (data as { post_enrich_delay_minutes?: number }).post_enrich_delay_minutes ?? 5,
    }
  }

  /** PATCH /enrichment/auto-enabled. Aceita os 2 campos opcionais. */
  async patchSettings(
    orgId: string,
    patch: { auto_enrichment_enabled?: boolean; post_enrich_delay_minutes?: number },
  ): Promise<{ auto_enrichment_enabled: boolean; post_enrich_delay_minutes: number }> {
    const update: Record<string, unknown> = {}
    if (typeof patch.auto_enrichment_enabled === 'boolean') update.auto_enrichment_enabled = patch.auto_enrichment_enabled
    if (typeof patch.post_enrich_delay_minutes === 'number') {
      const v = Math.max(0, Math.min(120, Math.floor(patch.post_enrich_delay_minutes)))
      update.post_enrich_delay_minutes = v
    }
    if (Object.keys(update).length === 0) {
      throw new BadRequestException('nenhum campo válido pra atualizar')
    }

    const { error } = await supabaseAdmin
      .from('organizations')
      .update(update)
      .eq('id', orgId)
    if (error) throw new BadRequestException(error.message)
    return this.getSettings(orgId)
  }

  // ── Post-enrichment template ────────────────────────────────────────────

  /** GET /enrichment/post-enrich-template. Retorna o template
   * post_enrichment_welcome (template_kind='post_enrichment_welcome') +
   * o delay configurado. Se ainda não existe, devolve um template "vazio
   * sugerido" pra UI exibir como rascunho. */
  async getPostEnrichTemplate(orgId: string): Promise<{
    id:               string | null
    name:             string
    message_body:     string
    is_active:        boolean
    delay_minutes:    number
  }> {
    const settings = await this.getSettings(orgId)
    const { data: tpl } = await supabaseAdmin
      .from('messaging_templates')
      .select('id, name, message_body, is_active')
      .eq('organization_id', orgId)
      .eq('template_kind', 'post_enrichment_welcome')
      .maybeSingle()

    if (tpl) {
      return {
        id:            tpl.id as string,
        name:          tpl.name as string,
        message_body:  tpl.message_body as string,
        is_active:     (tpl as { is_active?: boolean }).is_active ?? true,
        delay_minutes: settings.post_enrich_delay_minutes,
      }
    }
    // Default: rascunho sugerido pra primeiro uso
    return {
      id:            null,
      name:          'Pós-enriquecimento — boas-vindas',
      message_body:  'Olá {{nome}}, encontramos seu cadastro! Caso queira saber sobre as nossas novidades responda essa mensagem 🤝',
      is_active:     false,
      delay_minutes: settings.post_enrich_delay_minutes,
    }
  }

  /** POST /enrichment/post-enrich-template. Upsert do template +
   * atualização do delay. Aceita { message_body, is_active, delay_minutes }. */
  async upsertPostEnrichTemplate(
    orgId: string,
    body: {
      message_body?:  string
      is_active?:     boolean
      delay_minutes?: number
    },
  ): Promise<{ id: string; name: string; message_body: string; is_active: boolean; delay_minutes: number }> {
    if (!body.message_body || body.message_body.trim().length === 0) {
      throw new BadRequestException('message_body obrigatório')
    }

    // Atualiza delay primeiro (independente do template)
    if (typeof body.delay_minutes === 'number') {
      await this.patchSettings(orgId, { post_enrich_delay_minutes: body.delay_minutes })
    }

    // Upsert via select-then-insert/update — o índice único resolve race-safe
    const { data: existing } = await supabaseAdmin
      .from('messaging_templates')
      .select('id')
      .eq('organization_id', orgId)
      .eq('template_kind', 'post_enrichment_welcome')
      .maybeSingle()

    const row = {
      organization_id: orgId,
      template_kind:   'post_enrichment_welcome',
      name:            'Pós-enriquecimento — boas-vindas',
      channel:         'whatsapp',
      trigger_event:   'manual',
      message_body:    body.message_body.trim(),
      is_active:       body.is_active ?? true,
      updated_at:      new Date().toISOString(),
    }

    let saved: { id: string; name: string; message_body: string; is_active: boolean }
    if (existing?.id) {
      const { data, error } = await supabaseAdmin
        .from('messaging_templates')
        .update(row)
        .eq('id', existing.id)
        .select('id, name, message_body, is_active')
        .single()
      if (error) throw new BadRequestException(error.message)
      saved = data as { id: string; name: string; message_body: string; is_active: boolean }
    } else {
      const { data, error } = await supabaseAdmin
        .from('messaging_templates')
        .insert(row)
        .select('id, name, message_body, is_active')
        .single()
      if (error) throw new BadRequestException(error.message)
      saved = data as { id: string; name: string; message_body: string; is_active: boolean }
    }

    const settings = await this.getSettings(orgId)
    return { ...saved, delay_minutes: settings.post_enrich_delay_minutes }
  }
}
