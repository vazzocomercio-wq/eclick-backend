import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { TemplateRendererService } from './template-renderer.service'
import { EmailSenderService } from './email-sender.service'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { JourneyStep } from './messaging.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

interface TemplateRow {
  id:            string
  channel:       'whatsapp' | 'email' | string
  name:          string
  message_body:  string
}

type SendChannel = 'whatsapp' | 'email'

/** Cron @5min processa runs em status pending OU active (CC-1 grava pending,
 * legacy triggerJourney/fireForOrderEvents gravam active — engine aceita
 * ambos). Suporta DUAS shapes de step:
 *
 *   A) Legacy: { type: 'send_message'|'wait'|'condition', template_id, ... }
 *   B) CC-1:   { step, trigger, template_name, channel_priority, delay_minutes? }
 *
 * Em CC-1, trigger='immediate' envia agora; 'time_offset' arma com delay e
 * envia no tick seguinte; 'status_change_ml' pausa (next_step_at=null) e
 * fica esperando hook em CC-3. channel_priority='whatsapp_then_email' tenta
 * WA, faz fallback pra email se falhar; cada tentativa vira UM row em
 * messaging_sends pra auditoria. Rate limit 100ms entre runs. */
@Injectable()
export class JourneyEngineService {
  private readonly logger = new Logger(JourneyEngineService.name)

  constructor(
    private readonly renderer: TemplateRendererService,
    private readonly emailSender: EmailSenderService,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  @Cron('*/5 * * * *', { name: 'messagingJourneyTick' })
  async tick(): Promise<void> {
    await this.runOnce()
  }

  /** Idêntico ao tick, mas chamável via POST /messaging/runs/process-now
   * pra debug/testes manuais sem esperar 5min do cron.
   *
   * Multi-tenant: aceita orgId opcional. Sem orgId, query continua global
   * (cap 200) — runs herdam organization_id próprio em todas as
   * derivações, evitando vazamento. Com orgId, processa só aquela org
   * (admin trigger). */
  async runOnce(opts: { orgId?: string } = {}): Promise<{ processed: number; sent: number; failed: number; completed: number; duration_ms: number }> {
    const t0 = Date.now()
    let processed = 0, sent = 0, failed = 0, completed = 0

    let q = supabaseAdmin
      .from('messaging_journey_runs')
      .select('*')
      .in('status', ['pending', 'active'])
      .lte('next_step_at', new Date().toISOString())
      .order('next_step_at', { ascending: true })
      .limit(200)
    if (opts.orgId) q = q.eq('organization_id', opts.orgId)

    const { data: runs, error } = await q
    if (error) {
      this.logger.error(`[messaging.cron] fetch falhou: ${error.message}`)
      return { processed: 0, sent: 0, failed: 0, completed: 0, duration_ms: Date.now() - t0 }
    }
    if (!runs?.length) return { processed: 0, sent: 0, failed: 0, completed: 0, duration_ms: Date.now() - t0 }

    for (const run of runs as Row[]) {
      processed++
      try {
        const r = await this.processRun(run)
        if (r.sent)      sent++
        if (r.failed)    failed++
        if (r.completed) completed++
      } catch (e: unknown) {
        failed++
        const msg = (e as Error)?.message ?? 'erro'
        this.logger.warn(`[messaging.cron] run=${run.id} erro: ${msg}`)
        await this.markRun(run.id, 'failed')
      }
      // Rate limit ~10/s pra não estourar o WA quando há send_message
      await new Promise(r => setTimeout(r, 100))
    }

    const duration_ms = Date.now() - t0
    this.logger.log(`[messaging.cron] ${processed} runs processadas, ${sent} enviadas, ${failed} erros, ${completed} completadas — ${Math.round(duration_ms / 1000)}s`)
    return { processed, sent, failed, completed, duration_ms }
  }

  /** Porta de saída pra eventos imediatos de status de pedido (webhook ML,
   * UPDATE manual, etc). Funciona como CC-3 inline: busca runs paused
   * (next_step_at=null) com order_id matching, valida step.trigger=
   * 'status_change_ml' + step.condition.shipping_status === event, e
   * desbloqueia (next_step_at=now()). Idempotente: chamada repetida só
   * desbloqueia rows que ainda estão paused matching. CC-3 cron faz a
   * mesma coisa em loop @5min — esse método é o caminho rápido. */
  async triggerOrderEvent(
    orgId:   string,
    orderId: string,
    event:   'ready_to_ship' | 'shipped' | 'delivered',
  ): Promise<{ unblocked: number; checked: number }> {
    const { data: runs } = await supabaseAdmin
      .from('messaging_journey_runs')
      .select('id, journey_id, current_step, organization_id')
      .eq('organization_id', orgId)
      .eq('status', 'pending')
      .is('next_step_at', null)
      .eq('order_id', orderId)
    if (!runs?.length) {
      this.logger.log(`[messaging.event] org=${orgId} order=${orderId} event=${event} unblocked=0/0 (sem runs paused)`)
      return { unblocked: 0, checked: 0 }
    }

    let unblocked = 0
    for (const run of runs) {
      const { data: journey } = await supabaseAdmin
        .from('messaging_journeys').select('steps, is_active')
        .eq('id', run.journey_id as string)
        .eq('organization_id', orgId)
        .maybeSingle()
      if (!journey?.is_active) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const steps = (journey.steps ?? []) as any[]
      const step  = steps[run.current_step as number]
      if (!step || step.trigger !== 'status_change_ml') continue
      const expected = String(step.condition?.shipping_status ?? '').toLowerCase()
      if (expected !== event.toLowerCase()) continue

      // Re-fetch run pra preservar context existente. Marca
      // __triggered_step_${current_step} pra engine saber na 2ª passada
      // que pode enviar (em vez de re-pausar).
      const { data: full } = await supabaseAdmin
        .from('messaging_journey_runs').select('context')
        .eq('id', run.id as string).maybeSingle()
      const ctx = (full?.context ?? {}) as Record<string, unknown>
      const newCtx = { ...ctx, [`__triggered_step_${run.current_step}`]: new Date().toISOString() }

      await supabaseAdmin
        .from('messaging_journey_runs')
        .update({
          next_step_at: new Date().toISOString(),
          context:      newCtx,
          updated_at:   new Date().toISOString(),
        })
        .eq('id', run.id as string)
      unblocked++
    }
    this.logger.log(`[messaging.event] org=${orgId} order=${orderId} event=${event} unblocked=${unblocked}/${runs.length}`)
    return { unblocked, checked: runs.length }
  }

  private async processRun(run: Row): Promise<{ sent: boolean; failed: boolean; completed: boolean }> {
    const { data: journey } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, organization_id, steps, is_active')
      .eq('id', run.journey_id)
      .eq('organization_id', run.organization_id)
      .maybeSingle()
    if (!journey || !journey.is_active) {
      await this.markRun(run.id, 'failed')
      return { sent: false, failed: true, completed: false }
    }
    // Steps podem vir em duas shapes — cast genérico, cada branch decide
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = (journey.steps ?? []) as any[]
    const idx   = run.current_step ?? 0
    if (idx >= steps.length) {
      await this.markRun(run.id, 'completed')
      return { sent: false, failed: false, completed: true }
    }
    const step    = steps[idx]
    const orgId   = journey.organization_id as string
    const isLegacy = step.type === 'send_message' || step.type === 'wait' || step.type === 'condition'

    if (isLegacy) {
      return await this.processLegacyStep(run, step as JourneyStep, idx, steps.length, orgId)
    }
    // CC-1 shape — { step, trigger, template_name, channel_priority, ... }
    return await this.processCC1Step(run, step, idx, steps.length, orgId)
  }

  // ── Branch legacy (type=send_message|wait|condition) ───────────────────

  private async processLegacyStep(
    run: Row, step: JourneyStep, idx: number, total: number, orgId: string,
  ): Promise<{ sent: boolean; failed: boolean; completed: boolean }> {
    if (step.type === 'send_message') {
      const result = await this.executeSend(run, { template_id: step.template_id }, orgId)
      const advanced = await this.advance(run.id, idx, total)
      return { sent: result.success, failed: !result.success, completed: advanced.completed }
    }
    if (step.type === 'wait') {
      const ms = (step.delay_hours ?? 0) * 3_600_000 + (step.delay_days ?? 0) * 86_400_000
      await supabaseAdmin
        .from('messaging_journey_runs')
        .update({
          current_step: idx + 1,
          next_step_at: new Date(Date.now() + ms).toISOString(),
          status:       'pending',
          updated_at:   new Date().toISOString(),
        })
        .eq('id', run.id)
      return { sent: false, failed: false, completed: false }
    }
    // condition
    const ctx = (run.context ?? {}) as Record<string, unknown>
    const matches = step.condition_field
      ? String(ctx[step.condition_field] ?? '') === String(step.condition_value ?? '')
      : true
    if (matches) {
      const advanced = await this.advance(run.id, idx, total)
      return { sent: false, failed: false, completed: advanced.completed }
    }
    await this.markRun(run.id, 'completed')
    return { sent: false, failed: false, completed: true }
  }

  // ── Branch CC-1 (trigger + template_name + channel_priority) ───────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processCC1Step(
    run: Row, step: any, idx: number, total: number, orgId: string,
  ): Promise<{ sent: boolean; failed: boolean; completed: boolean }> {
    const trig = (step.trigger as string | undefined) ?? 'immediate'

    if (trig === 'immediate') {
      const result = await this.executeSend(run, {
        template_name:    step.template_name as string | undefined,
        channel_priority: step.channel_priority as string | undefined,
      }, orgId)
      const advanced = await this.advance(run.id, idx, total)
      return { sent: result.success, failed: !result.success, completed: advanced.completed }
    }

    if (trig === 'status_change_ml') {
      // 2 passadas: 1ª pausa esperando CC-3; 2ª (após CC-3 setar
      // __triggered_step_${idx}) envia template + avança. Simétrico ao
      // __armed_step pra time_offset.
      const ctx = (run.context ?? {}) as Record<string, unknown>
      const triggeredKey = `__triggered_step_${idx}`
      if (ctx[triggeredKey]) {
        // CC-3 confirmou evento → envia template do step + advance
        const result = await this.executeSend(run, {
          template_name:    step.template_name as string | undefined,
          channel_priority: step.channel_priority as string | undefined,
        }, orgId)
        const advanced = await this.advance(run.id, idx, total)
        return { sent: result.success, failed: !result.success, completed: advanced.completed }
      }
      // 1ª passada — pausa esperando CC-3 detectar mudança de status
      await supabaseAdmin
        .from('messaging_journey_runs')
        .update({ status: 'pending', next_step_at: null, updated_at: new Date().toISOString() })
        .eq('id', run.id)
      this.logger.log(`[messaging.cron] run=${run.id} step=${idx} aguardando status_change_ml (CC-3)`)
      return { sent: false, failed: false, completed: false }
    }

    if (trig === 'time_offset') {
      // Arma+envia: 1ª passada bumpa next_step_at e marca em context.
      // 2ª passada (após delay) envia e avança.
      const delayMs = (Number(step.delay_minutes) || 0) * 60_000
      const ctx     = (run.context ?? {}) as Record<string, unknown>
      const armedKey = `__armed_step_${idx}`
      if (!ctx[armedKey]) {
        await supabaseAdmin
          .from('messaging_journey_runs')
          .update({
            next_step_at: new Date(Date.now() + delayMs).toISOString(),
            context:      { ...ctx, [armedKey]: new Date().toISOString() },
            updated_at:   new Date().toISOString(),
          })
          .eq('id', run.id)
        return { sent: false, failed: false, completed: false }
      }
      const result = await this.executeSend(run, {
        template_name:    step.template_name as string | undefined,
        channel_priority: step.channel_priority as string | undefined,
      }, orgId)
      const advanced = await this.advance(run.id, idx, total)
      return { sent: result.success, failed: !result.success, completed: advanced.completed }
    }

    this.logger.warn(`[messaging.cron] run=${run.id} step=${idx} trigger='${trig}' desconhecido — pulando`)
    const advanced = await this.advance(run.id, idx, total)
    return { sent: false, failed: false, completed: advanced.completed }
  }

  // ── Send pipeline ──────────────────────────────────────────────────────

  /** Resolve template (por id OU name+org) e envia conforme channel_priority.
   * 'whatsapp_then_email' tenta WA primeiro e só vai pra email se WA falhar.
   * Cada tentativa vira 1 row em messaging_sends pra auditoria. */
  private async executeSend(
    run:   Row,
    spec:  { template_id?: string; template_name?: string; channel_priority?: string },
    orgId: string,
  ): Promise<{ success: boolean }> {
    const tpl = await this.resolveTemplate(spec, orgId)
    if (!tpl) {
      this.logger.warn(`[messaging.send] run=${run.id} template não encontrado (${spec.template_id ?? spec.template_name ?? '?'})`)
      return { success: false }
    }

    const ctx      = (run.context ?? {}) as Record<string, unknown>
    const rendered = this.renderer.render(tpl.message_body, ctx)
    const plan     = this.buildChannelPlan(spec.channel_priority, tpl.channel)

    if (plan.length === 0) {
      this.logger.warn(`[messaging.send] run=${run.id} sem canal viável (priority=${spec.channel_priority ?? 'null'} tpl.channel=${tpl.channel})`)
      return { success: false }
    }

    let success = false
    for (const ch of plan) {
      const r = await this.attemptSend(ch, orgId, run, ctx, tpl, rendered)
      this.logger.log(
        `[messaging.send] run=${run.id} step=${run.current_step} channel=${ch} status=${r.success ? 'sent' : 'failed'}${r.error ? ` err=${r.error}` : ''}`,
      )
      await supabaseAdmin.from('messaging_sends').insert({
        organization_id: orgId,
        journey_run_id:  run.id,
        template_id:     tpl.id,
        channel:         ch,
        phone:           ch === 'whatsapp' ? run.phone : run.email,
        customer_id:     run.customer_id ?? null,
        order_id:        run.order_id    ?? null,
        message_body:    rendered,
        status:          r.success ? 'sent' : 'failed',
        sent_at:         r.success ? new Date().toISOString() : null,
        error:           r.success ? null : (r.error ?? null),
      })
      if (r.success) { success = true; break }
    }
    return { success }
  }

  private async resolveTemplate(
    spec: { template_id?: string; template_name?: string },
    orgId: string,
  ): Promise<TemplateRow | null> {
    if (spec.template_id) {
      // FIX multi-tenant: filtra por org junto com id pra defender contra
      // colisão (improvável com UUID v4 mas é zero overhead).
      const { data } = await supabaseAdmin
        .from('messaging_templates')
        .select('id, channel, name, message_body')
        .eq('id', spec.template_id)
        .eq('organization_id', orgId)
        .maybeSingle()
      return (data as TemplateRow | null) ?? null
    }
    if (spec.template_name) {
      const { data } = await supabaseAdmin
        .from('messaging_templates')
        .select('id, channel, name, message_body')
        .eq('organization_id', orgId)
        .eq('name', spec.template_name)
        .eq('is_active', true)
        .limit(1)
      return (data?.[0] as TemplateRow | null) ?? null
    }
    return null
  }

  private buildChannelPlan(priority: string | undefined, tplChannel: string): SendChannel[] {
    switch (priority) {
      case 'whatsapp_then_email': return ['whatsapp', 'email']
      case 'email_then_whatsapp': return ['email', 'whatsapp']
      case 'whatsapp':            return ['whatsapp']
      case 'email':               return ['email']
    }
    if (tplChannel === 'whatsapp' || tplChannel === 'email') return [tplChannel]
    return []
  }

  private async attemptSend(
    channel: SendChannel, orgId: string, run: Row, ctx: Record<string, unknown>, tpl: TemplateRow, rendered: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (channel === 'whatsapp') {
      const cfg = await this.waConfig.findActive()
      if (!cfg) return { success: false, error: 'WhatsApp não configurado' }
      const phone = (run.phone as string | null) ?? (ctx.recipient_phone as string | null) ?? null
      if (!phone) return { success: false, error: 'phone ausente no run/context' }
      const r = await this.waSender.sendTextMessage({ phone, message: rendered, waConfig: cfg })
      return { success: r.success, error: r.error ?? undefined }
    }
    // email — EM-1 multi-tenant: passa orgId pro dispatcher buscar config
    // criptografada em email_settings. subject usa tpl.subject (coluna nova)
    // com fallback pra tpl.name pra compat com templates legados.
    const to = (ctx.recipient_email as string | undefined) ?? null
    if (!to) return { success: false, error: 'recipient_email ausente no context' }
    const subject = (tpl as { subject?: string | null }).subject ?? tpl.name ?? '(sem assunto)'
    return await this.emailSender.sendEmail({ orgId, to, subject, body: rendered })
  }

  /** @returns completed=true quando esse advance encerrou a jornada. */
  private async advance(runId: string, idx: number, total: number): Promise<{ completed: boolean }> {
    const next = idx + 1
    if (next >= total) {
      await this.markRun(runId, 'completed')
      return { completed: true }
    }
    await supabaseAdmin
      .from('messaging_journey_runs')
      .update({
        current_step: next,
        next_step_at: new Date().toISOString(),
        status:       'pending',
        updated_at:   new Date().toISOString(),
      })
      .eq('id', runId)
    return { completed: false }
  }

  private async markRun(runId: string, status: 'completed' | 'failed'): Promise<void> {
    await supabaseAdmin
      .from('messaging_journey_runs')
      .update({
        status,
        next_step_at: null,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', runId)
  }
}
