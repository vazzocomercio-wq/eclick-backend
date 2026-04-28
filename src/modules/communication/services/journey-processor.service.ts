import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { EnrichmentService } from '../../enrichment/enrichment.service'
import { CustomerResolverService, OrderTriggerSnapshot } from './customer-resolver.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

interface OrderCommunicationJourney {
  id:                       string
  organization_id:          string
  journey_id:               string
  state:                    'pending' | 'active' | 'blocked_consent' | 'blocked_no_contact' | 'failed'
  trigger_snapshot:         Json
  customer_id:              string | null
  enrichment_attempted_at:  string | null
  enrichment_succeeded_at:  string | null
  stopped_reason:           string | null
  last_error:               string | null
  started_at:               string | null
  created_at:               string
}

interface JourneyStep {
  step:               number
  trigger:            string
  channel_priority:   string
  template_kind:      string
  template_name:      string
  delay_minutes?:     number
}

interface PickChannelResult {
  channel:            'whatsapp' | 'email' | 'none'
  reason?:            string
  recipient_phone?:   string
  recipient_email?:   string
  phone_is_whatsapp?: boolean
  has_wa_consent?:    boolean
  has_email_consent?: boolean
  customer_id?:       string
  template_kind?:     string
}

export interface ProcessResult {
  ocj_id:       string
  final_state:  string
  duration_ms:  number
  error?:       string
}

export interface ProcessPendingResponse {
  processed:          number
  results:            ProcessResult[]
  total_duration_ms:  number
}

/** Worker CC-1: lê order_communication_journeys com state='pending', resolve
 * customer, opcionalmente enriquece, decide canal via pick_communication_channel,
 * e dispara step 1 criando registro em messaging_journey_runs. CC-2 vai fazer
 * o envio real e avançar steps. */
@Injectable()
export class JourneyProcessorService {
  private readonly logger = new Logger(JourneyProcessorService.name)
  private isRunning = false

  constructor(
    private readonly resolver:   CustomerResolverService,
    private readonly enrichment: EnrichmentService,
  ) {}

  @Cron('*/30 * * * * *', { name: 'processCommunicationJourneysTick' })
  async tick(): Promise<void> {
    if (this.isRunning) return // evita overlap se cron disparar antes do anterior terminar
    this.isRunning = true
    try {
      const r = await this.processPending(10)
      if (r.processed > 0) {
        const counts = r.results.reduce<Record<string, number>>((m, x) => {
          m[x.final_state] = (m[x.final_state] ?? 0) + 1
          return m
        }, {})
        const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')
        this.logger.log(`[CC-1.cron] ${r.processed} processadas | ${summary} — ${r.total_duration_ms}ms`)
      }
    } catch (e: unknown) {
      this.logger.error(`[CC-1.cron] tick falhou: ${(e as Error)?.message}`)
    } finally {
      this.isRunning = false
    }
  }

  /** Processa até `limit` jornadas pending. Cada uma é isolada em try/catch
   * — exceções viram state='failed' + last_error, nunca derrubam o loop. */
  async processPending(limit = 10): Promise<ProcessPendingResponse> {
    const t0 = Date.now()

    const { data: pending, error } = await supabaseAdmin
      .from('order_communication_journeys')
      .select('*')
      .eq('state', 'pending')
      .order('created_at', { ascending: true })
      .limit(Math.min(Math.max(limit, 1), 100))

    if (error) {
      this.logger.error(`[CC-1.fetch] falhou: ${error.message}`)
      return { processed: 0, results: [], total_duration_ms: Date.now() - t0 }
    }

    const journeys = (pending ?? []) as OrderCommunicationJourney[]
    const results: ProcessResult[] = []

    for (const ocj of journeys) {
      const tStart = Date.now()
      try {
        const finalState = await this.processOne(ocj)
        results.push({ ocj_id: ocj.id, final_state: finalState, duration_ms: Date.now() - tStart })
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? 'erro desconhecido'
        this.logger.error(`[CC-1.error] ocj=${ocj.id} ${msg}`)
        await supabaseAdmin
          .from('order_communication_journeys')
          .update({ state: 'failed', last_error: msg.slice(0, 1000), updated_at: new Date().toISOString() })
          .eq('id', ocj.id)
        results.push({ ocj_id: ocj.id, final_state: 'failed', duration_ms: Date.now() - tStart, error: msg })
      }
    }

    return { processed: journeys.length, results, total_duration_ms: Date.now() - t0 }
  }

  /** Pipeline pra 1 journey. Retorna o state final. */
  private async processOne(ocj: OrderCommunicationJourney): Promise<string> {
    const snapshot = (ocj.trigger_snapshot ?? {}) as OrderTriggerSnapshot
    const orgId = ocj.organization_id

    // ─── (b) Resolve customer via CPF ─────────────────────────────────────
    if (!snapshot.buyer_doc_number) {
      return await this.markBlocked(ocj.id, 'blocked_no_contact', 'snapshot_sem_cpf')
    }
    const customerId = await this.resolver.upsertByCpf(orgId, snapshot.buyer_doc_number, snapshot)

    // ─── (c) Persist customer_id ─────────────────────────────────────────
    await supabaseAdmin
      .from('order_communication_journeys')
      .update({ customer_id: customerId, updated_at: new Date().toISOString() })
      .eq('id', ocj.id)

    // ─── (d) Carrega contatos atuais ─────────────────────────────────────
    const { data: customer } = await supabaseAdmin
      .from('unified_customers')
      .select('phone, validated_whatsapp, email')
      .eq('id', customerId)
      .maybeSingle()
    const cur = (customer ?? {}) as { phone?: string | null; validated_whatsapp?: boolean | null; email?: string | null }

    // ─── (e) Enrichment opcional ─────────────────────────────────────────
    let enrichmentSucceededAt: string | null = null
    if (!cur.phone && snapshot.buyer_doc_number) {
      await supabaseAdmin
        .from('order_communication_journeys')
        .update({ enrichment_attempted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', ocj.id)

      const cpfClean = snapshot.buyer_doc_number.replace(/\D/g, '')
      const enrichResult = await this.enrichment.enrich({
        organization_id: orgId,
        query_type:      'cpf',
        query_value:     cpfClean,
        customer_id:     customerId,
        trigger_source:  'auto',
      })

      // Log raw retornado pra debug fácil (item 4 do user)
      this.logger.log(`[CC-1.enrich.raw] ocj=${ocj.id} ${JSON.stringify({
        provider:    enrichResult.provider,
        quality:     enrichResult.quality,
        success:     enrichResult.success,
        error:       enrichResult.error,
        cache_hit:   enrichResult.cache_hit,
        attempts:    enrichResult.attempts,
        data_keys:   Object.keys(enrichResult.data ?? {}),
        phones_n:    Array.isArray(enrichResult.data?.phones) ? enrichResult.data.phones.length : 0,
        emails_n:    Array.isArray(enrichResult.data?.emails) ? enrichResult.data.emails.length : 0,
      })}`)

      // Detecta consent block
      const errMsg = (enrichResult.error ?? '').toLowerCase()
      if (enrichResult.quality === 'error' && (errMsg === 'no_consent' || errMsg.includes('consent'))) {
        return await this.markBlocked(ocj.id, 'blocked_consent', 'enrichment_no_consent')
      }

      if (enrichResult.quality === 'full' || enrichResult.quality === 'partial') {
        const d = enrichResult.data ?? {}
        const phone0  = d.phones?.[0]
        const email0  = d.emails?.find(e => e.is_valid !== false)
        const update: Record<string, unknown> = {
          enrichment_status:  'success',
          enrichment_quality: enrichResult.quality,
          enriched_at:        new Date().toISOString(),
          enrichment_data:    d,
        }
        if (phone0?.number) {
          update.phone               = phone0.number
          update.validated_whatsapp  = !!phone0.is_whatsapp
        }
        if (email0?.address)        update.email      = email0.address
        if (d.address?.city)        update.city       = d.address.city
        if (d.address?.state)       update.state      = d.address.state
        if (d.birth_date)           update.birth_date = d.birth_date

        const { error: upErr } = await supabaseAdmin
          .from('unified_customers')
          .update(update)
          .eq('id', customerId)
        if (upErr) {
          this.logger.warn(`[CC-1.enrich.update] falhou: ${upErr.message}`)
        } else {
          enrichmentSucceededAt = new Date().toISOString()
          await supabaseAdmin
            .from('order_communication_journeys')
            .update({ enrichment_succeeded_at: enrichmentSucceededAt, updated_at: new Date().toISOString() })
            .eq('id', ocj.id)
        }
      }
      // quality === 'empty' ou 'error' (não-consent): sem update mas segue
      // pro pick_channel — pode ainda ter email no snapshot/customer
    }

    // ─── (f-g) Lê step 1 da jornada ──────────────────────────────────────
    const { data: journey, error: jErr } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, steps')
      .eq('id', ocj.journey_id)
      .maybeSingle()
    if (jErr || !journey) {
      throw new Error(`journey ${ocj.journey_id} não encontrada: ${jErr?.message ?? 'null'}`)
    }
    const steps = (journey.steps ?? []) as JourneyStep[]
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`journey ${ocj.journey_id} sem steps`)
    }
    const step = steps[0]
    if (!step.template_name || !step.template_kind || !step.channel_priority) {
      throw new Error(`step[0] mal-formado: ${JSON.stringify(step)}`)
    }

    // ─── (h) Decide canal ────────────────────────────────────────────────
    const { data: pickRaw, error: pickErr } = await supabaseAdmin.rpc('pick_communication_channel', {
      p_ocj_id:           ocj.id,
      p_template_kind:    step.template_kind,
      p_channel_priority: step.channel_priority,
    })
    if (pickErr) {
      throw new Error(`pick_communication_channel falhou: ${pickErr.message}`)
    }
    const pick = (pickRaw ?? {}) as PickChannelResult

    this.logger.log(`[CC-1.pick] ocj=${ocj.id} ${JSON.stringify({
      channel:            pick.channel,
      reason:             pick.reason,
      phone_is_whatsapp:  pick.phone_is_whatsapp,
      has_wa_consent:     pick.has_wa_consent,
      has_email_consent:  pick.has_email_consent,
      recipient_phone:    pick.recipient_phone ? `${pick.recipient_phone.slice(0,4)}***` : null,
      recipient_email:    pick.recipient_email ? `${pick.recipient_email.slice(0,3)}***` : null,
    })}`)

    // ─── (i) Channel === 'none' → bloqueia ───────────────────────────────
    if (pick.channel === 'none') {
      const reason  = pick.reason ?? 'no_channel_available'
      const blocked = reason.toLowerCase().includes('consent') ? 'blocked_consent' : 'blocked_no_contact'
      return await this.markBlocked(ocj.id, blocked, reason)
    }

    // ─── (j) Canal OK → busca template + insere journey_run ──────────────
    if (pick.channel !== 'whatsapp' && pick.channel !== 'email') {
      throw new Error(`channel desconhecido: ${pick.channel}`)
    }

    const { data: template, error: tErr } = await supabaseAdmin
      .from('messaging_templates')
      .select('id')
      .eq('organization_id', orgId)
      .eq('name', step.template_name)
      .eq('is_active', true)
      .eq('channel', pick.channel)
      .limit(1)
      .maybeSingle()
    if (tErr) throw new Error(`template lookup falhou: ${tErr.message}`)
    if (!template?.id) {
      throw new Error(`template '${step.template_name}' (channel=${pick.channel}) não encontrado pra org ${orgId}`)
    }

    // Recipient depende do canal escolhido — função SQL retorna phone+email
    // separados, escolhemos pelo channel pra coluna phone (legacy) e
    // preservamos AMBOS no context pra debug futuro.
    const recipient = pick.channel === 'whatsapp'
      ? (pick.recipient_phone ?? null)
      : (pick.recipient_email ?? null)

    // Context completo pro template renderer (CC-2). Faz JOIN com
    // unified_customers + orders pra popular vars conhecidas:
    // first_name, full_name, order_id, product_name, total_amount,
    // store_name, seller_nickname. tracking_code/delivery_date só ficam
    // disponíveis após hook de status (CC-3) — null por agora.
    const { data: customerRow } = await supabaseAdmin
      .from('unified_customers')
      .select('display_name')
      .eq('id', customerId)
      .maybeSingle()
    const fullName  = (customerRow?.display_name as string | null | undefined) ?? snapshot.buyer_name ?? null
    const firstName = fullName ? fullName.split(/\s+/)[0] ?? null : null

    let productName:    string | null = null
    let totalAmount:    string | null = null
    let sellerNickname: string | null = null
    if (snapshot.external_order_id) {
      const { data: orderRow } = await supabaseAdmin
        .from('orders')
        .select('raw_data')
        .eq('external_order_id', snapshot.external_order_id)
        .maybeSingle()
      const raw = (orderRow?.raw_data ?? {}) as {
        total_amount?:   number | string
        order_items?:   Array<{ item?: { title?: string } }>
        seller?:        { nickname?: string }
      }
      productName    = raw.order_items?.[0]?.item?.title ?? null
      totalAmount    = raw.total_amount != null ? String(raw.total_amount) : null
      sellerNickname = raw.seller?.nickname ?? null
    }

    const runRow = {
      organization_id: orgId,
      journey_id:      ocj.journey_id,
      order_id:        snapshot.external_order_id ?? null,
      customer_id:     customerId,
      phone:           recipient,
      current_step:    1,
      status:          'pending',
      next_step_at:    new Date().toISOString(),
      context: {
        // Identificação interna
        ocj_id:          ocj.id,
        channel:         pick.channel,
        recipient,
        recipient_phone: pick.recipient_phone ?? null,
        recipient_email: pick.recipient_email ?? null,
        template_id:     template.id,
        template_name:   step.template_name,
        // Vars do template renderer
        first_name:      firstName,
        full_name:       fullName,
        order_id:        snapshot.external_order_id ?? null,
        product_name:    productName,
        total_amount:    totalAmount,
        store_name:      'Vazzo Comercio',
        seller_nickname: sellerNickname,
        tracking_code:   null,
        delivery_date:   null,
      },
    }
    const { error: runErr } = await supabaseAdmin
      .from('messaging_journey_runs')
      .insert(runRow)
    if (runErr) {
      throw new Error(`insert messaging_journey_runs falhou: ${runErr.message}`)
    }

    // ─── Marca ocj como active ───────────────────────────────────────────
    const updateActive: Record<string, unknown> = {
      state:      'active',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (enrichmentSucceededAt) updateActive.enrichment_succeeded_at = enrichmentSucceededAt
    await supabaseAdmin
      .from('order_communication_journeys')
      .update(updateActive)
      .eq('id', ocj.id)

    this.logger.log(`[CC-1.active] ${JSON.stringify({
      sprint:       'CC-1',
      org_id:       orgId,
      ocj_id:       ocj.id,
      customer_id:  customerId,
      decision:     `${pick.channel}:${step.template_name}`,
    })}`)

    return 'active'
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async markBlocked(
    ocjId:  string,
    state:  'blocked_consent' | 'blocked_no_contact',
    reason: string,
  ): Promise<string> {
    await supabaseAdmin
      .from('order_communication_journeys')
      .update({
        state,
        stopped_reason: reason,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', ocjId)
    this.logger.log(`[CC-1.blocked] ocj=${ocjId} state=${state} reason=${reason}`)
    return state
  }
}
