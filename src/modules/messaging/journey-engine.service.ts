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

/** Cron @5min processa runs em status pending OU active (CC-1 grava pending,
 * legacy triggerJourney/fireForOrderEvents gravam active — engine aceita
 * ambos). send_message renderiza+envia via WA ou email (stub); wait reagenda
 * next_step_at; condition avalia context[field] vs value e completa se não
 * bater. Rate limit 100ms entre runs (~10/s WA cap). Falhas em send_message
 * marcam messaging_sends.status=failed mas o run avança (não trava jornadas
 * inteiras por 1 send falho). */
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
   * pra debug/testes manuais sem esperar 5min do cron. */
  async runOnce(): Promise<{ processed: number; sent: number; failed: number; completed: number; duration_ms: number }> {
    const t0 = Date.now()
    let processed = 0, sent = 0, failed = 0, completed = 0

    const { data: runs, error } = await supabaseAdmin
      .from('messaging_journey_runs')
      .select('*')
      .in('status', ['pending', 'active'])
      .lte('next_step_at', new Date().toISOString())
      .order('next_step_at', { ascending: true })
      .limit(200)
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

  /** API pública pra futura integração com order status hook (CC-3). Por
   * agora apenas loga — o ML real-time fetch atual não persiste status
   * em orders, então não há onde plugar listener nativo ainda. */
  async triggerOrderEvent(orderId: string, event: 'ready_to_ship' | 'shipped' | 'delivered'): Promise<void> {
    this.logger.log(`[messaging.event] order=${orderId} event=${event} (CC-3: implementar avanço de step correspondente)`)
  }

  private async processRun(run: Row): Promise<{ sent: boolean; failed: boolean; completed: boolean }> {
    const { data: journey } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, organization_id, steps, is_active')
      .eq('id', run.journey_id)
      .maybeSingle()
    if (!journey || !journey.is_active) {
      await this.markRun(run.id, 'failed')
      return { sent: false, failed: true, completed: false }
    }
    const steps = (journey.steps ?? []) as JourneyStep[]
    const idx   = run.current_step ?? 0
    if (idx >= steps.length) {
      await this.markRun(run.id, 'completed')
      return { sent: false, failed: false, completed: true }
    }
    const step = steps[idx]

    if (step.type === 'send_message') {
      const result = await this.executeSend(run, step, journey.organization_id as string)
      const advanced = await this.advance(run.id, idx, steps.length)
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
    if (step.type === 'condition') {
      const ctx = (run.context ?? {}) as Record<string, unknown>
      const matches = step.condition_field
        ? String(ctx[step.condition_field] ?? '') === String(step.condition_value ?? '')
        : true
      if (matches) {
        const advanced = await this.advance(run.id, idx, steps.length)
        return { sent: false, failed: false, completed: advanced.completed }
      }
      await this.markRun(run.id, 'completed')
      return { sent: false, failed: false, completed: true }
    }
    // Tipo desconhecido — pula
    const advanced = await this.advance(run.id, idx, steps.length)
    return { sent: false, failed: false, completed: advanced.completed }
  }

  private async executeSend(
    run:   Row,
    step:  JourneyStep,
    orgId: string,
  ): Promise<{ success: boolean }> {
    if (!step.template_id) return { success: false }
    const { data: tpl } = await supabaseAdmin
      .from('messaging_templates')
      .select('id, channel, name, message_body')
      .eq('id', step.template_id)
      .maybeSingle()
    if (!tpl) return { success: false }

    const ctx = (run.context ?? {}) as Record<string, unknown>
    const rendered = this.renderer.render(tpl.message_body as string, ctx)

    let success = false
    let err: string | null = null

    if (tpl.channel === 'whatsapp') {
      const cfg = await this.waConfig.findActive()
      if (!cfg) {
        err = 'WhatsApp não configurado'
      } else if (!run.phone) {
        err = 'phone vazio no run'
      } else {
        const r = await this.waSender.sendTextMessage({
          phone:    run.phone,
          message:  rendered,
          waConfig: cfg,
        })
        success = r.success
        err = r.error ?? null
      }
    } else if (tpl.channel === 'email') {
      const to = (ctx.recipient_email as string | undefined) ?? null
      if (!to) {
        err = 'recipient_email ausente no context'
      } else {
        // Sem coluna subject em messaging_templates — usa o name como assunto
        // até CC-3 adicionar suporte. Stub do EmailSender só loga.
        const subject = (tpl.name as string | null) ?? '(sem assunto)'
        const r = await this.emailSender.sendEmail({ to, subject, body: rendered })
        success = r.success
        err = r.error ?? null
      }
    } else {
      err = `Canal ${tpl.channel} não suportado`
    }

    this.logger.log(
      `[messaging.send] run=${run.id} step=${run.current_step} channel=${tpl.channel} status=${success ? 'sent' : 'failed'}${err ? ` err=${err}` : ''}`,
    )

    await supabaseAdmin.from('messaging_sends').insert({
      organization_id: orgId,
      journey_run_id:  run.id,
      template_id:     step.template_id,
      channel:         tpl.channel,
      phone:           run.phone,
      customer_id:     run.customer_id ?? null,
      order_id:        run.order_id    ?? null,
      message_body:    rendered,
      status:          success ? 'sent' : 'failed',
      sent_at:         success ? new Date().toISOString() : null,
      error:           err,
    })
    return { success }
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
