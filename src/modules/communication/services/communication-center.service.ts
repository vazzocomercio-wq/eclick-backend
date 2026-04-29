import { Injectable, Logger, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MessagingService, MessagingTemplate } from '../../messaging/messaging.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

export interface JourneyListItem {
  ocj_id:                string
  state:                 string
  customer_name:         string | null
  product_title:         string | null
  current_step:          number | null
  total_steps:           number | null
  last_message_sent_at:  string | null
  created_at:            string
}

export interface CommunicationSettings {
  organization_id:           string
  auto_communication_enabled: boolean
  brand_display_name:        string | null
  brand_tone:                string | null
  send_window_start:         string | null
  send_window_end:           string | null
  send_timezone:             string | null
  marketing_optin_moment:    string | null
  default_channel_priority:  string | null
  pause_after_days_no_reply: number | null
  created_at:                string
  updated_at:                string
}

export interface FunnelCounts {
  journeys_created:           number
  customers_enriched:         number
  journeys_active:            number
  journeys_blocked_consent:   number
  journeys_blocked_no_contact: number
  messages_sent:              number
  messages_failed:            number
}

export interface TimelineDay {
  date:             string  // YYYY-MM-DD
  messages_sent:    number
  messages_failed:  number
  journeys_created: number
}

/** Whitelist de campos updatable via PATCH /communication/settings.
 * `organization_id` nunca; created_at/updated_at gerenciados pelo banco. */
const SETTINGS_WHITELIST: Array<keyof CommunicationSettings> = [
  'auto_communication_enabled',
  'brand_display_name',
  'brand_tone',
  'send_window_start',
  'send_window_end',
  'send_timezone',
  'marketing_optin_moment',
  'default_channel_priority',
  'pause_after_days_no_reply',
]

/** Centro de comunicação — agregações + queries cross-table que o frontend
 * consome em /dashboard/comunicacao. Templates CRUD reaproveita
 * MessagingService (já testado), customizando só DELETE pra soft delete. */
@Injectable()
export class CommunicationCenterService {
  private readonly logger = new Logger(CommunicationCenterService.name)

  constructor(private readonly messaging: MessagingService) {}

  // ── Journeys ────────────────────────────────────────────────────────────

  async listJourneys(
    orgId: string,
    filters: { state?: string; limit?: number },
  ): Promise<JourneyListItem[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200)

    let q = supabaseAdmin
      .from('order_communication_journeys')
      .select('id, state, journey_id, customer_id, order_id, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (filters.state) q = q.eq('state', filters.state)

    const { data: ocjsRaw, error } = await q
    if (error) throw new BadRequestException(error.message)
    const ocjs = (ocjsRaw ?? []) as unknown as Array<{
      id:           string
      state:        string
      journey_id:   string
      customer_id:  string | null
      order_id:     string | null
      created_at:   string
    }>
    if (ocjs.length === 0) return []

    // Batch lookup: journeys (pra total_steps)
    const journeyIds = [...new Set(ocjs.map(o => o.journey_id))]
    const { data: journeysRaw } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, steps')
      .eq('organization_id', orgId)
      .in('id', journeyIds)
    const journeyMap = new Map<string, number>()
    for (const j of (journeysRaw ?? []) as unknown as Array<{ id: string; steps: unknown }>) {
      journeyMap.set(j.id, Array.isArray(j.steps) ? j.steps.length : 0)
    }

    // Batch lookup: customers
    const customerIds = [...new Set(ocjs.map(o => o.customer_id).filter(Boolean) as string[])]
    const customerMap = new Map<string, string>()
    if (customerIds.length > 0) {
      const { data: cs } = await supabaseAdmin
        .from('unified_customers')
        .select('id, display_name')
        .eq('organization_id', orgId)
        .in('id', customerIds)
      for (const c of (cs ?? []) as unknown as Array<{ id: string; display_name: string | null }>) {
        if (c.display_name) customerMap.set(c.id, c.display_name)
      }
    }

    // Batch lookup: orders (product_title)
    const orderIds = [...new Set(ocjs.map(o => o.order_id).filter(Boolean) as string[])]
    const orderMap = new Map<string, string | null>()
    if (orderIds.length > 0) {
      const { data: os } = await supabaseAdmin
        .from('orders')
        .select('id, product_title')
        .eq('organization_id', orgId)
        .in('id', orderIds)
      for (const o of (os ?? []) as unknown as Array<{ id: string; product_title: string | null }>) {
        orderMap.set(o.id, o.product_title)
      }
    }

    // Batch lookup: runs por OCJ (pra current_step + run_ids pra sends)
    // PostgREST não suporta filter "context->>ocj_id IN (...)" via .in(),
    // então batemos uma query por org + filtramos em memória pelos OCJ ids.
    const ocjIdSet = new Set(ocjs.map(o => o.id))
    const { data: runsRaw } = await supabaseAdmin
      .from('messaging_journey_runs')
      .select('id, current_step, context, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit * 5) // margem caso haja várias runs por OCJ
    const runsByOcj = new Map<string, { runId: string; currentStep: number | null }>()
    for (const r of (runsRaw ?? []) as unknown as Array<{ id: string; current_step: number | null; context: Record<string, unknown> }>) {
      const ocjId = r.context?.ocj_id as string | undefined
      if (!ocjId || !ocjIdSet.has(ocjId)) continue
      // Mais recente vence (já vem ordenado DESC)
      if (!runsByOcj.has(ocjId)) {
        runsByOcj.set(ocjId, { runId: r.id, currentStep: r.current_step ?? null })
      }
    }

    // Batch lookup: último messaging_sends por run
    const runIds = [...runsByOcj.values()].map(v => v.runId)
    const lastSentByRun = new Map<string, string>()
    if (runIds.length > 0) {
      const { data: sendsRaw } = await supabaseAdmin
        .from('messaging_sends')
        .select('journey_run_id, sent_at')
        .eq('organization_id', orgId)
        .in('journey_run_id', runIds)
        .not('sent_at', 'is', null)
        .order('sent_at', { ascending: false })
      for (const s of (sendsRaw ?? []) as unknown as Array<{ journey_run_id: string; sent_at: string }>) {
        if (!lastSentByRun.has(s.journey_run_id)) lastSentByRun.set(s.journey_run_id, s.sent_at)
      }
    }

    return ocjs.map<JourneyListItem>(o => {
      const run         = o.id ? runsByOcj.get(o.id) : undefined
      const totalSteps  = journeyMap.get(o.journey_id) ?? null
      const lastSentAt  = run ? lastSentByRun.get(run.runId) ?? null : null
      return {
        ocj_id:               o.id,
        state:                o.state,
        customer_name:        o.customer_id ? customerMap.get(o.customer_id) ?? null : null,
        product_title:        o.order_id    ? orderMap.get(o.order_id)       ?? null : null,
        current_step:         run?.currentStep ?? null,
        total_steps:          totalSteps && totalSteps > 0 ? totalSteps : null,
        last_message_sent_at: lastSentAt,
        created_at:           o.created_at,
      }
    })
  }

  // ── Templates (proxy MessagingService + soft delete custom) ─────────────

  async listTemplates(orgId: string): Promise<MessagingTemplate[]> {
    return this.messaging.listTemplates(orgId)
  }

  async createTemplate(orgId: string, body: Partial<MessagingTemplate>): Promise<MessagingTemplate> {
    if (!body?.name) throw new BadRequestException('name obrigatório')
    await this.assertNameUnique(orgId, body.name)
    return this.messaging.createTemplate(orgId, body)
  }

  async updateTemplate(orgId: string, id: string, patch: Partial<MessagingTemplate>): Promise<MessagingTemplate> {
    // Se renomeou, valida unicidade do novo nome (excluindo o próprio id)
    if (patch?.name) await this.assertNameUnique(orgId, patch.name, id)
    return this.messaging.updateTemplate(orgId, id, patch)
  }

  /** Soft delete — preserva histórico de runs/sends. UPDATE is_active=false. */
  async softDeleteTemplate(orgId: string, id: string): Promise<{ ok: true }> {
    const { data: existing } = await supabaseAdmin
      .from('messaging_templates').select('id, is_active')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!existing) throw new NotFoundException('template não encontrado')
    const { error } = await supabaseAdmin
      .from('messaging_templates')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  private async assertNameUnique(orgId: string, name: string, excludeId?: string): Promise<void> {
    let q = supabaseAdmin
      .from('messaging_templates').select('id')
      .eq('organization_id', orgId)
      .eq('name', name)
    if (excludeId) q = q.neq('id', excludeId)
    const { data } = await q.limit(1).maybeSingle()
    if (data) throw new ConflictException(`Já existe template com nome "${name}"`)
  }

  // ── Settings ────────────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<CommunicationSettings | null> {
    const { data, error } = await supabaseAdmin
      .from('organization_communication_settings')
      .select('*')
      .eq('organization_id', orgId)
      .maybeSingle()
    if (error) throw new BadRequestException(error.message)
    return (data as unknown as CommunicationSettings | null) ?? null
  }

  async updateSettings(orgId: string, patch: Partial<CommunicationSettings>): Promise<CommunicationSettings> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of SETTINGS_WHITELIST) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }
    if (Object.keys(update).length === 1) {
      throw new BadRequestException('nenhum campo válido pra atualizar')
    }
    const { data, error } = await supabaseAdmin
      .from('organization_communication_settings')
      .update(update)
      .eq('organization_id', orgId)
      .select()
      .single()
    if (error) throw new BadRequestException(error.message)
    return data as unknown as CommunicationSettings
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  async getFunnel(orgId: string): Promise<FunnelCounts> {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()

    const ocjBase = () => supabaseAdmin
      .from('order_communication_journeys')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
    const sendsBase = () => supabaseAdmin
      .from('messaging_sends')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)

    const [
      created,
      enriched,
      active,
      blockedConsent,
      blockedNoContact,
      messagesSent,
      messagesFailed,
    ] = await Promise.all([
      ocjBase().gte('created_at', since),
      // customers_enriched: distinct unified_customers enriquecidos na janela
      supabaseAdmin
        .from('unified_customers')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .gte('enriched_at', since)
        .in('enrichment_status', ['full', 'partial']),
      ocjBase().eq('state', 'active'),
      ocjBase().eq('state', 'blocked_consent'),
      ocjBase().eq('state', 'blocked_no_contact'),
      sendsBase().eq('status', 'sent').gte('sent_at', since),
      sendsBase().eq('status', 'failed').gte('created_at', since),
    ])

    return {
      journeys_created:            created.count ?? 0,
      customers_enriched:          enriched.count ?? 0,
      journeys_active:             active.count ?? 0,
      journeys_blocked_consent:    blockedConsent.count ?? 0,
      journeys_blocked_no_contact: blockedNoContact.count ?? 0,
      messages_sent:               messagesSent.count ?? 0,
      messages_failed:             messagesFailed.count ?? 0,
    }
  }

  async getTimeline(orgId: string, days: number): Promise<TimelineDay[]> {
    const cap   = Math.min(Math.max(days, 1), 365)
    const since = new Date(Date.now() - cap * 86_400_000)
    const sinceIso = since.toISOString()

    const [sendsRes, ocjsRes] = await Promise.all([
      supabaseAdmin
        .from('messaging_sends')
        .select('status, sent_at, created_at')
        .eq('organization_id', orgId)
        .gte('created_at', sinceIso)
        .limit(50_000),
      supabaseAdmin
        .from('order_communication_journeys')
        .select('created_at')
        .eq('organization_id', orgId)
        .gte('created_at', sinceIso)
        .limit(50_000),
    ])

    // Bucket por dia (YYYY-MM-DD)
    const buckets = new Map<string, TimelineDay>()
    const ensure = (date: string) => {
      let row = buckets.get(date)
      if (!row) {
        row = { date, messages_sent: 0, messages_failed: 0, journeys_created: 0 }
        buckets.set(date, row)
      }
      return row
    }

    type SendRow = { status: string; sent_at: string | null; created_at: string }
    for (const s of (sendsRes.data ?? []) as unknown as SendRow[]) {
      // Falhas usam created_at (sent_at é null em failures)
      if (s.status === 'sent' && s.sent_at) {
        ensure(s.sent_at.slice(0, 10)).messages_sent++
      } else if (s.status === 'failed') {
        ensure(s.created_at.slice(0, 10)).messages_failed++
      }
    }
    type OcjRow = { created_at: string }
    for (const o of (ocjsRes.data ?? []) as unknown as OcjRow[]) {
      ensure(o.created_at.slice(0, 10)).journeys_created++
    }

    // Preenche dias vazios pra gráfico contínuo
    const result: TimelineDay[] = []
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    for (let i = cap - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000)
      const key = d.toISOString().slice(0, 10)
      result.push(buckets.get(key) ?? {
        date: key, messages_sent: 0, messages_failed: 0, journeys_created: 0,
      })
    }
    return result
  }
}
