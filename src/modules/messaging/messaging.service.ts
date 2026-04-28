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

    const cfg = await this.waConfig.findActive()
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
}
