import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { TemplateRendererService } from './template-renderer.service'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { JourneyStep } from './messaging.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any

/** Cron @5min processa runs ativos. send_message renderiza+envia via WA;
 * wait reagenda next_step_at; condition avalia context[field] vs value
 * e completa se não bater. Rate limit 100ms entre runs (~10/s WA cap).
 * Falhas em send_message marcam messaging_sends.status=failed mas o run
 * avança (não trava jornadas inteiras por 1 send falho). */
@Injectable()
export class JourneyEngineService {
  private readonly logger = new Logger(JourneyEngineService.name)

  constructor(
    private readonly renderer: TemplateRendererService,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  @Cron('*/5 * * * *', { name: 'messagingJourneyTick' })
  async tick(): Promise<void> {
    const t0 = Date.now()
    let processed = 0, sent = 0, failed = 0

    const { data: runs, error } = await supabaseAdmin
      .from('messaging_journey_runs')
      .select('*')
      .eq('status', 'active')
      .lte('next_step_at', new Date().toISOString())
      .order('next_step_at', { ascending: true })
      .limit(200)
    if (error) {
      this.logger.error(`[messaging.cron] fetch falhou: ${error.message}`)
      return
    }
    if (!runs?.length) return

    for (const run of runs as Row[]) {
      processed++
      try {
        const r = await this.processRun(run)
        if (r.sent)   sent++
        if (r.failed) failed++
      } catch (e: unknown) {
        failed++
        const msg = (e as Error)?.message ?? 'erro'
        this.logger.warn(`[messaging.cron] run=${run.id} erro: ${msg}`)
        await this.markRun(run.id, 'failed')
      }
      // Rate limit ~10/s pra não estourar o WA quando há send_message
      await new Promise(r => setTimeout(r, 100))
    }

    const dur = Math.round((Date.now() - t0) / 1000)
    this.logger.log(`[messaging.cron] ${processed} runs processados, ${sent} enviados, ${failed} falhas — ${dur}s`)
  }

  private async processRun(run: Row): Promise<{ sent: boolean; failed: boolean }> {
    const { data: journey } = await supabaseAdmin
      .from('messaging_journeys')
      .select('id, organization_id, steps, is_active')
      .eq('id', run.journey_id)
      .maybeSingle()
    if (!journey || !journey.is_active) {
      await this.markRun(run.id, 'failed')
      return { sent: false, failed: true }
    }
    const steps = (journey.steps ?? []) as JourneyStep[]
    const idx   = run.current_step ?? 0
    if (idx >= steps.length) {
      await this.markRun(run.id, 'completed')
      return { sent: false, failed: false }
    }
    const step = steps[idx]

    if (step.type === 'send_message') {
      const result = await this.executeSend(run, step, journey.organization_id as string)
      await this.advance(run.id, idx, steps.length)
      return { sent: result.success, failed: !result.success }
    }
    if (step.type === 'wait') {
      const ms = (step.delay_hours ?? 0) * 3_600_000 + (step.delay_days ?? 0) * 86_400_000
      await supabaseAdmin
        .from('messaging_journey_runs')
        .update({
          current_step: idx + 1,
          next_step_at: new Date(Date.now() + ms).toISOString(),
          updated_at:   new Date().toISOString(),
        })
        .eq('id', run.id)
      return { sent: false, failed: false }
    }
    if (step.type === 'condition') {
      const ctx = (run.context ?? {}) as Record<string, unknown>
      const matches = step.condition_field
        ? String(ctx[step.condition_field] ?? '') === String(step.condition_value ?? '')
        : true
      if (matches) await this.advance(run.id, idx, steps.length)
      else         await this.markRun(run.id, 'completed')
      return { sent: false, failed: false }
    }
    // Tipo desconhecido — pula
    await this.advance(run.id, idx, steps.length)
    return { sent: false, failed: false }
  }

  private async executeSend(
    run:   Row,
    step:  JourneyStep,
    orgId: string,
  ): Promise<{ success: boolean }> {
    if (!step.template_id) return { success: false }
    const { data: tpl } = await supabaseAdmin
      .from('messaging_templates')
      .select('id, channel, message_body')
      .eq('id', step.template_id)
      .maybeSingle()
    if (!tpl) return { success: false }

    const rendered = this.renderer.render(
      tpl.message_body as string,
      (run.context ?? {}) as Record<string, unknown>,
    )

    let success = false
    let err: string | null = null
    if (tpl.channel === 'whatsapp') {
      const cfg = await this.waConfig.findActive()
      if (!cfg) {
        err = 'WhatsApp não configurado'
      } else {
        const r = await this.waSender.sendTextMessage({
          phone:    run.phone,
          message:  rendered,
          waConfig: cfg,
        })
        success = r.success
        err = r.error ?? null
      }
    } else {
      err = `Canal ${tpl.channel} não implementado`
    }

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

  private async advance(runId: string, idx: number, total: number): Promise<void> {
    const next = idx + 1
    if (next >= total) {
      await this.markRun(runId, 'completed')
      return
    }
    await supabaseAdmin
      .from('messaging_journey_runs')
      .update({
        current_step: next,
        next_step_at: new Date().toISOString(),
        updated_at:   new Date().toISOString(),
      })
      .eq('id', runId)
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
