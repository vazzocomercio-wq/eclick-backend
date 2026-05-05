import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { TemplateRendererService } from './template-renderer.service'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'

export type MessagingChannel = 'whatsapp' | 'instagram' | 'tiktok'
export type TriggerEvent =
  | 'order_paid' | 'order_shipped' | 'order_delivered' | 'order_cancelled'
  | 'post_sale_7d' | 'post_sale_30d' | 'manual' | 'lead_bridge_capture'
export type JourneyMode = 'automatic' | 'manual' | 'campaign'

export interface MessagingTemplate {
  id:              string
  organization_id: string
  name:            string
  channel:         MessagingChannel
  trigger_event:   TriggerEvent
  message_body:    string
  variables:       string[]
  is_active:       boolean
  created_at:      string
  updated_at:      string
}

export interface JourneyStep {
  order:            number
  type:             'send_message' | 'wait' | 'condition'
  template_id?:     string
  delay_hours?:     number
  delay_days?:      number
  condition_field?: string
  condition_value?: unknown
}

export interface MessagingJourney {
  id:              string
  organization_id: string
  name:            string
  description:     string | null
  trigger_event:   TriggerEvent
  trigger_channel: MessagingChannel
  is_active:       boolean
  mode:            JourneyMode
  steps:           JourneyStep[]
  created_at:      string
  updated_at:      string
}

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name)

  constructor(
    private readonly renderer: TemplateRendererService,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  // ── Templates ───────────────────────────────────────────────────────────

  async listTemplates(orgId: string): Promise<MessagingTemplate[]> {
    const { data, error } = await supabaseAdmin
      .from('messaging_templates')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as MessagingTemplate[]
  }

  async createTemplate(
    orgId: string,
    input: Partial<MessagingTemplate>,
  ): Promise<MessagingTemplate> {
    if (!input.name)          throw new BadRequestException('name obrigatório')
    if (!input.message_body)  throw new BadRequestException('message_body obrigatório')
    if (!input.trigger_event) throw new BadRequestException('trigger_event obrigatório')

    const variables = input.variables ?? this.renderer.extractVariables(input.message_body)
    const row = {
      organization_id: orgId,
      name:            input.name,
      channel:         input.channel ?? 'whatsapp',
      trigger_event:   input.trigger_event,
      message_body:    input.message_body,
      variables,
      is_active:       input.is_active ?? true,
    }
    const { data, error } = await supabaseAdmin
      .from('messaging_templates').insert(row).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as MessagingTemplate
  }

  async updateTemplate(
    orgId: string,
    id:    string,
    patch: Partial<MessagingTemplate>,
  ): Promise<MessagingTemplate> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of ['name','channel','trigger_event','message_body','variables','is_active'] as const) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }
    if (patch.message_body !== undefined && patch.variables === undefined) {
      update.variables = this.renderer.extractVariables(patch.message_body)
    }
    const { data, error } = await supabaseAdmin
      .from('messaging_templates').update(update)
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException('template não encontrado')
    return data as MessagingTemplate
  }

  async deleteTemplate(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('messaging_templates').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  /** Renderiza template + envia teste via WhatsApp. Persiste em
   * messaging_sends pra rastrear histórico de previews. */
  async previewTemplate(
    orgId:   string,
    id:      string,
    input:   { phone: string; context?: Record<string, unknown> },
  ): Promise<{ ok: boolean; message_id?: string; rendered: string; error?: string }> {
    if (!input?.phone) throw new BadRequestException('phone obrigatório')

    const { data: tpl, error } = await supabaseAdmin
      .from('messaging_templates').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!tpl)   throw new NotFoundException('template não encontrado')

    const rendered = this.renderer.render(tpl.message_body, input.context ?? {})

    if (tpl.channel !== 'whatsapp') {
      return { ok: false, rendered, error: `Canal ${tpl.channel} ainda não implementado` }
    }

    const cfg = await this.waConfig.findActive(orgId)
    if (!cfg) return { ok: false, rendered, error: 'WhatsApp Business não configurado' }

    const result = await this.waSender.sendTextMessage({
      phone:    input.phone,
      message:  rendered,
      waConfig: cfg,
    })

    await supabaseAdmin.from('messaging_sends').insert({
      organization_id: orgId,
      template_id:     id,
      channel:         tpl.channel,
      phone:           input.phone,
      message_body:    rendered,
      status:          result.success ? 'sent' : 'failed',
      sent_at:         result.success ? new Date().toISOString() : null,
      error:           result.error ?? null,
    })

    return {
      ok:         result.success,
      message_id: result.message_id,
      rendered,
      error:      result.error,
    }
  }

  // ── Journeys ────────────────────────────────────────────────────────────

  async listJourneys(orgId: string): Promise<MessagingJourney[]> {
    const { data, error } = await supabaseAdmin
      .from('messaging_journeys')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as MessagingJourney[]
  }

  async createJourney(
    orgId: string,
    input: Partial<MessagingJourney>,
  ): Promise<MessagingJourney> {
    if (!input.name)          throw new BadRequestException('name obrigatório')
    if (!input.trigger_event) throw new BadRequestException('trigger_event obrigatório')

    const row = {
      organization_id: orgId,
      name:            input.name,
      description:     input.description ?? null,
      trigger_event:   input.trigger_event,
      trigger_channel: input.trigger_channel ?? 'whatsapp',
      is_active:       input.is_active ?? true,
      mode:            input.mode ?? 'automatic',
      steps:           input.steps ?? [],
    }
    const { data, error } = await supabaseAdmin
      .from('messaging_journeys').insert(row).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as MessagingJourney
  }

  async updateJourney(
    orgId: string,
    id:    string,
    patch: Partial<MessagingJourney>,
  ): Promise<MessagingJourney> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of ['name','description','trigger_event','trigger_channel','is_active','mode','steps'] as const) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }
    const { data, error } = await supabaseAdmin
      .from('messaging_journeys').update(update)
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException('journey não encontrada')
    return data as MessagingJourney
  }

  async deleteJourney(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('messaging_journeys').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  /** Cria uma run pra journey — step 0 imediato. O engine (C2) processa
   * os runs ativos no cron. */
  async triggerJourney(
    orgId: string,
    journeyId: string,
    input: {
      order_id?:    string
      customer_id?: string
      phone:        string
      context?:     Record<string, unknown>
    },
  ): Promise<{ run_id: string }> {
    if (!input?.phone) throw new BadRequestException('phone obrigatório')

    const { data: journey, error } = await supabaseAdmin
      .from('messaging_journeys').select('*')
      .eq('id', journeyId).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!journey)        throw new NotFoundException('journey não encontrada')
    if (!journey.is_active) throw new BadRequestException('journey desativada')

    const { data: run, error: e2 } = await supabaseAdmin
      .from('messaging_journey_runs').insert({
        organization_id: orgId,
        journey_id:      journeyId,
        order_id:        input.order_id  ?? null,
        customer_id:     input.customer_id ?? null,
        phone:           input.phone,
        current_step:    0,
        status:          'active',
        next_step_at:    new Date().toISOString(),
        context:         input.context ?? {},
      }).select('id').single()
    if (e2) throw new BadRequestException(e2.message)
    return { run_id: run!.id as string }
  }

  // ── Auto-trigger from orders ingestion ──────────────────────────────────

  /** Mapeia status do order → trigger event correspondente. Retorna null
   * pra status que não disparam jornada. */
  private statusToTrigger(status: string | null | undefined): TriggerEvent | null {
    switch ((status ?? '').toLowerCase()) {
      case 'paid':      return 'order_paid'
      case 'shipped':   return 'order_shipped'
      case 'delivered': return 'order_delivered'
      case 'cancelled': return 'order_cancelled'
    }
    return null
  }

  /** Chamado pelo OrdersIngestionService após upsert. Cria journey_runs
   * pra cada (event × journey ativo) que ainda não foi disparado pra esse
   * order_id+journey_id. Skipa orders sem buyer_phone (sem como mandar WA).
   * Retorna {fired, skipped} pra log. */
  async fireForOrderEvents(
    orgId: string,
    events: Array<{
      external_order_id: string
      status:            string | null
      buyer_phone:       string | null
      buyer_name:        string | null
      product_title:     string | null
    }>,
  ): Promise<{ fired: number; skipped: number }> {
    let fired = 0, skipped = 0
    if (events.length === 0) return { fired, skipped }

    // Agrupa eventos por trigger_event
    const byEvent = new Map<TriggerEvent, typeof events>()
    for (const e of events) {
      const trig = this.statusToTrigger(e.status)
      if (!trig)             { skipped++; continue }
      if (!e.buyer_phone)    { skipped++; continue }
      const list = byEvent.get(trig) ?? []
      list.push(e)
      byEvent.set(trig, list)
    }
    if (byEvent.size === 0) return { fired, skipped }

    // Journeys ativos pra esses triggers
    const { data: journeys, error: jErr } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, trigger_event')
      .eq('organization_id', orgId)
      .eq('is_active', true)
      .in('trigger_event', [...byEvent.keys()])
    if (jErr) {
      this.logger.warn(`[messaging.trigger] fetch journeys falhou: ${jErr.message}`)
      return { fired, skipped: skipped + events.length }
    }
    if (!journeys?.length) return { fired, skipped: skipped + events.length }

    // Dedup: lê runs existentes pra (journey_id, order_id)
    const orderIds = events.map(e => e.external_order_id)
    const { data: existing } = await supabaseAdmin
      .from('messaging_journey_runs')
      .select('journey_id, order_id')
      .eq('organization_id', orgId)
      .in('order_id', orderIds)
    const dupKeys = new Set((existing ?? []).map(r => `${r.journey_id}|${r.order_id}`))

    const inserts: Record<string, unknown>[] = []
    for (const [trig, evList] of byEvent) {
      const matchingJ = journeys.filter(j => j.trigger_event === trig)
      for (const j of matchingJ) {
        for (const e of evList) {
          if (dupKeys.has(`${j.id}|${e.external_order_id}`)) { skipped++; continue }
          inserts.push({
            organization_id: orgId,
            journey_id:      j.id,
            order_id:        e.external_order_id,
            customer_id:     null,
            phone:           e.buyer_phone,
            current_step:    0,
            status:          'active',
            next_step_at:    new Date().toISOString(),
            context: {
              nome:    e.buyer_name ?? '',
              pedido:  e.external_order_id,
              produto: e.product_title ?? '',
              loja:    'Vazzo',
              phone:   e.buyer_phone,
            },
          })
          fired++
        }
      }
    }
    if (inserts.length > 0) {
      const { error: iErr } = await supabaseAdmin.from('messaging_journey_runs').insert(inserts)
      if (iErr) this.logger.warn(`[messaging.trigger] insert runs falhou: ${iErr.message}`)
    }
    if (fired > 0) {
      this.logger.log(`[messaging.trigger] org=${orgId} fired=${fired} skipped=${skipped}`)
    }
    return { fired, skipped }
  }

  // ── Campaigns ───────────────────────────────────────────────────────────

  /** Disparo em massa via segment. Cap 500 destinatários por call (50s
   * @ 100ms/send). Persiste cada envio em messaging_sends. Retorna
   * {total, sent, failed}. message_override permite editar mensagem do
   * template no momento da campanha. */
  async sendCampaign(
    orgId: string,
    input: {
      template_id:       string
      segment:           'all' | 'with_cpf' | 'vip' | 'custom'
      customer_ids?:     string[]
      message_override?: string
    },
  ): Promise<{ total: number; sent: number; failed: number }> {
    if (!input?.template_id) throw new BadRequestException('template_id obrigatório')

    const { data: tpl } = await supabaseAdmin
      .from('messaging_templates').select('*')
      .eq('id', input.template_id).eq('organization_id', orgId).maybeSingle()
    if (!tpl)                       throw new NotFoundException('template não encontrado')
    if (tpl.channel !== 'whatsapp') throw new BadRequestException(`Canal ${tpl.channel} não implementado`)

    const cfg = await this.waConfig.findActive(orgId)
    if (!cfg) throw new BadRequestException('WhatsApp Business não configurado')

    let q = supabaseAdmin
      .from('unified_customers')
      .select('id, display_name, phone, cpf, tags')
      .eq('organization_id', orgId)
      .eq('is_deleted', false)
      .not('phone', 'is', null)

    if (input.segment === 'with_cpf') q = q.not('cpf', 'is', null)
    if (input.segment === 'vip')      q = q.contains('tags', ['vip'])
    if (input.segment === 'custom') {
      if (!input.customer_ids?.length) throw new BadRequestException('customer_ids obrigatório para segment=custom')
      q = q.in('id', input.customer_ids)
    }
    q = q.limit(500) // cap pra não estourar HTTP timeout

    const { data: customers, error } = await q
    if (error) throw new BadRequestException(error.message)
    if (!customers?.length) return { total: 0, sent: 0, failed: 0 }

    const baseMessage = input.message_override ?? tpl.message_body
    let sent = 0, failed = 0

    for (const c of customers) {
      const rendered = this.renderer.render(baseMessage, {
        nome: c.display_name ?? '',
        loja: 'Vazzo',
      })
      const result = await this.waSender.sendTextMessage({
        phone:    c.phone as string,
        message:  rendered,
        waConfig: cfg,
      })
      await supabaseAdmin.from('messaging_sends').insert({
        organization_id: orgId,
        template_id:     input.template_id,
        channel:         'whatsapp',
        phone:           c.phone,
        customer_id:     c.id,
        message_body:    rendered,
        status:          result.success ? 'sent' : 'failed',
        sent_at:         result.success ? new Date().toISOString() : null,
        error:           result.error ?? null,
      })
      if (result.success) sent++
      else                failed++
      await new Promise(r => setTimeout(r, 100)) // rate limit 10/s WA
    }

    this.logger.log(`[messaging.campaign] org=${orgId} tpl=${input.template_id} segment=${input.segment} total=${customers.length} sent=${sent} failed=${failed}`)
    return { total: customers.length, sent, failed }
  }

  /** Envio individual usado pelo CampaignsService.processCampaignTargets.
   * Renderiza template (ou usa customMessage), envia WA, persiste em
   * messaging_sends e devolve {success, messaging_send_id, error?}. Não dorme
   * — quem chama é responsável por rate-limit. */
  async sendOne(
    orgId:        string,
    customerId:   string,
    templateId:   string | null,
    customMessage?: string,
  ): Promise<{ success: boolean; messaging_send_id?: string; error?: string }> {
    const { data: customer } = await supabaseAdmin
      .from('unified_customers')
      .select('id, display_name, phone')
      .eq('id', customerId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!customer)        return { success: false, error: 'customer não encontrado' }
    if (!customer.phone)  return { success: false, error: 'customer sem phone' }

    let body = customMessage ?? ''
    if (!body && templateId) {
      const { data: tpl } = await supabaseAdmin
        .from('messaging_templates').select('message_body, channel')
        .eq('id', templateId).eq('organization_id', orgId).maybeSingle()
      if (!tpl) return { success: false, error: 'template não encontrado' }
      body = tpl.message_body as string
    }
    if (!body) return { success: false, error: 'sem corpo de mensagem' }

    const rendered = this.renderer.render(body, {
      nome: customer.display_name ?? '',
      loja: 'Vazzo',
    })

    const cfg = await this.waConfig.findActive(orgId)
    if (!cfg) return { success: false, error: 'WhatsApp Business não configurado' }

    const result = await this.waSender.sendTextMessage({
      phone:    customer.phone as string,
      message:  rendered,
      waConfig: cfg,
    })

    const { data: sendRow } = await supabaseAdmin
      .from('messaging_sends').insert({
        organization_id: orgId,
        template_id:     templateId,
        channel:         'whatsapp',
        phone:           customer.phone,
        customer_id:     customer.id,
        message_body:    rendered,
        status:          result.success ? 'sent' : 'failed',
        sent_at:         result.success ? new Date().toISOString() : null,
        error:           result.error ?? null,
      })
      .select('id').single()

    return {
      success:           result.success,
      messaging_send_id: sendRow?.id as string | undefined,
      error:             result.error,
    }
  }

  // ── Analytics ───────────────────────────────────────────────────────────

  /** Sumário de envios no período. Default: últimos 30 dias. */
  async getAnalytics(
    orgId: string,
    fromIso?: string,
    toIso?: string,
  ): Promise<{
    total_sent:     number
    delivered_rate: number
    read_rate:      number
    failed_rate:    number
    by_template:    Array<{ template_id: string; name: string; sent: number; delivered: number; read: number; failed: number }>
    by_day:         Array<{ date: string; sent: number; delivered: number }>
  }> {
    const from = fromIso ?? new Date(Date.now() - 30 * 86_400_000).toISOString()
    const to   = toIso   ?? new Date().toISOString()

    const { data: sends, error } = await supabaseAdmin
      .from('messaging_sends')
      .select('id, template_id, status, sent_at, delivered_at, read_at, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', from)
      .lte('created_at', to)
    if (error) throw new BadRequestException(error.message)

    const all = (sends ?? []) as Array<{
      template_id: string | null; status: string
      sent_at: string | null; delivered_at: string | null; read_at: string | null
      created_at: string
    }>

    const totalSent = all.filter(s => s.status !== 'pending').length
    const delivered = all.filter(s => !!s.delivered_at).length
    const read      = all.filter(s => !!s.read_at).length
    const failed    = all.filter(s => s.status === 'failed').length

    // by_template
    const tplIds = [...new Set(all.map(s => s.template_id).filter(Boolean) as string[])]
    let tplMap = new Map<string, string>()
    if (tplIds.length > 0) {
      // FIX multi-tenant: filtra por org junto com in(ids) — defesa contra
      // collision (UUID v4 quase impossível, mas zero overhead).
      const { data: tpls } = await supabaseAdmin
        .from('messaging_templates').select('id, name')
        .eq('organization_id', orgId)
        .in('id', tplIds)
      tplMap = new Map((tpls ?? []).map(t => [t.id as string, t.name as string]))
    }
    const byTplMap = new Map<string, { sent: number; delivered: number; read: number; failed: number }>()
    for (const s of all) {
      if (!s.template_id) continue
      const cur = byTplMap.get(s.template_id) ?? { sent: 0, delivered: 0, read: 0, failed: 0 }
      if (s.status !== 'pending')  cur.sent++
      if (s.delivered_at)           cur.delivered++
      if (s.read_at)                cur.read++
      if (s.status === 'failed')    cur.failed++
      byTplMap.set(s.template_id, cur)
    }
    const by_template = [...byTplMap.entries()].map(([template_id, v]) => ({
      template_id, name: tplMap.get(template_id) ?? '?', ...v,
    }))

    // by_day (usa sent_at se houver, senão created_at)
    const byDayMap = new Map<string, { sent: number; delivered: number }>()
    for (const s of all) {
      const day = (s.sent_at ?? s.created_at).slice(0, 10)
      const cur = byDayMap.get(day) ?? { sent: 0, delivered: 0 }
      if (s.status !== 'pending') cur.sent++
      if (s.delivered_at)         cur.delivered++
      byDayMap.set(day, cur)
    }
    const by_day = [...byDayMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }))

    return {
      total_sent:     totalSent,
      delivered_rate: totalSent > 0 ? delivered / totalSent : 0,
      read_rate:      totalSent > 0 ? read      / totalSent : 0,
      failed_rate:    totalSent > 0 ? failed    / totalSent : 0,
      by_template,
      by_day,
    }
  }

  // ── Sends ───────────────────────────────────────────────────────────────

  async listSends(
    orgId:  string,
    filters: {
      status?:      string
      from?:        string
      to?:          string
      customer_id?: string
      journey_id?:  string
      limit?:       number
      offset?:      number
    },
  ) {
    let q = supabaseAdmin
      .from('messaging_sends')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (filters.status)      q = q.eq('status', filters.status)
    if (filters.from)        q = q.gte('created_at', filters.from)
    if (filters.to)          q = q.lte('created_at', filters.to)
    if (filters.customer_id) q = q.eq('customer_id', filters.customer_id)
    if (filters.journey_id)  q = q.eq('journey_run_id', filters.journey_id)

    const limit  = Math.min(Math.max(filters.limit  ?? 50, 1), 200)
    const offset = Math.max(filters.offset ?? 0, 0)
    q = q.range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)
    return { items: data ?? [], total: count ?? 0, limit, offset }
  }

  // ── Runs (jornadas em execução) ─────────────────────────────────────────

  /** GET /messaging/runs — paginado, com filtros. */
  async listRuns(
    orgId: string,
    filters: {
      status?:      string
      journey_id?:  string
      customer_id?: string
      from?:        string
      to?:          string
      limit?:       number
      offset?:      number
    },
  ) {
    let q = supabaseAdmin
      .from('messaging_journey_runs')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (filters.status)      q = q.eq('status', filters.status)
    if (filters.journey_id)  q = q.eq('journey_id', filters.journey_id)
    if (filters.customer_id) q = q.eq('customer_id', filters.customer_id)
    if (filters.from)        q = q.gte('created_at', filters.from)
    if (filters.to)          q = q.lte('created_at', filters.to)

    const limit  = Math.min(Math.max(filters.limit  ?? 50, 1), 200)
    const offset = Math.max(filters.offset ?? 0, 0)
    q = q.range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)
    return { items: data ?? [], total: count ?? 0, limit, offset }
  }

  /** GET /messaging/runs/:id — run + journey steps + sends. */
  async getRun(orgId: string, id: string) {
    const { data: run, error } = await supabaseAdmin
      .from('messaging_journey_runs').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(error.message)
    if (!run)  throw new NotFoundException('run não encontrada')

    const { data: journey } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, name, trigger_event, steps')
      .eq('id', run.journey_id as string).maybeSingle()

    const { data: sends } = await supabaseAdmin
      .from('messaging_sends')
      .select('*')
      .eq('journey_run_id', id)
      .order('created_at', { ascending: true })

    return { run, journey: journey ?? null, sends: sends ?? [] }
  }

  /** POST /messaging/runs/:id/skip-step — pula step atual. Reagenda
   * imediato (next_step_at=now()) pra cron pegar logo. Se não tiver
   * próximo step → completed. */
  async skipStep(orgId: string, id: string): Promise<{ ok: true; current_step: number; status: string }> {
    const { data: run } = await supabaseAdmin
      .from('messaging_journey_runs').select('id, current_step, status, journey_id, organization_id')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!run) throw new NotFoundException('run não encontrada')
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'paused') {
      throw new BadRequestException(`run em status ${run.status} — não dá pra pular step`)
    }

    const { data: journey } = await supabaseAdmin
      .from('messaging_journeys').select('steps')
      .eq('id', run.journey_id as string).maybeSingle()
    const total = Array.isArray(journey?.steps) ? (journey!.steps as JourneyStep[]).length : 0
    const next  = (run.current_step as number ?? 0) + 1

    if (next >= total) {
      await supabaseAdmin
        .from('messaging_journey_runs')
        .update({ status: 'completed', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', id)
      return { ok: true, current_step: next, status: 'completed' }
    }
    await supabaseAdmin
      .from('messaging_journey_runs')
      .update({
        current_step: next,
        next_step_at: new Date().toISOString(),
        status:       'pending',
        updated_at:   new Date().toISOString(),
      })
      .eq('id', id)
    return { ok: true, current_step: next, status: 'pending' }
  }

  /** POST /messaging/runs/:id/cancel — pausa permanente. Constraint
   * permite paused; o motivo vai em context.cancel_reason (sempre preserva
   * keys existentes). Não desativa cron — só cron skipa rows paused. */
  async cancelRun(orgId: string, id: string, reason?: string): Promise<{ ok: true }> {
    const { data: run } = await supabaseAdmin
      .from('messaging_journey_runs').select('id, status, context')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!run) throw new NotFoundException('run não encontrada')
    if (run.status === 'completed' || run.status === 'paused' || run.status === 'failed') {
      throw new BadRequestException(`run já em status terminal: ${run.status}`)
    }
    const ctx = (run.context ?? {}) as Record<string, unknown>
    const newCtx = { ...ctx, cancel_reason: reason ?? 'cancelled', cancelled_at: new Date().toISOString() }
    const { error } = await supabaseAdmin
      .from('messaging_journey_runs')
      .update({
        status:       'paused',
        next_step_at: null,
        context:      newCtx,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', id)
    if (error) throw new BadRequestException(error.message)
    this.logger.log(`[messaging.cancel] run=${id} reason=${reason ?? 'cancelled'}`)
    return { ok: true }
  }
}
