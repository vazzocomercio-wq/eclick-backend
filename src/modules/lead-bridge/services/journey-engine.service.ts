import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { WhatsAppTriggerService } from './whatsapp-trigger.service'

/** A journey step. The `type` field tells the engine what to do; the rest
 * of the keys depend on the type. Stored in lead_bridge_journeys.steps. */
type JourneyStep =
  | { type: 'send_whatsapp'; message: string }
  | { type: 'wait_hours';    hours: number }
  | { type: 'wait_days';     days: number }
  | { type: 'branch_by_engagement'; threshold: number; if_above: number; if_below: number }

@Injectable()
export class JourneyEngineService {
  private readonly logger = new Logger(JourneyEngineService.name)

  constructor(private readonly waTrigger: WhatsAppTriggerService) {}

  /** Cron — every 5 minutes. Picks up runs whose next_step_at has elapsed
   * and advances them through their journey steps. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick() {
    try {
      const { data: runs } = await supabaseAdmin
        .from('lead_bridge_journey_runs')
        .select('id, conversion_id, journey_id, current_step, journey:lead_bridge_journeys(steps)')
        .eq('status', 'active')
        .lte('next_step_at', new Date().toISOString())
        .limit(100)

      if (!runs?.length) return

      let processed = 0
      for (const run of runs) {
        try {
          await this.advance(run as Record<string, unknown>)
          processed++
        } catch (e: unknown) {
          const err = e as { message?: string }
          this.logger.warn(`[lb.journey.tick] run=${(run as Record<string, unknown>).id}: ${err?.message}`)
        }
      }

      if (processed > 0) {
        this.logger.log(`[lb.journey] ${processed} run(s) avançaram`)
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[lb.journey.tick] falhou: ${err?.message}`)
    }
  }

  private async advance(run: Record<string, unknown>): Promise<void> {
    const journey = run.journey as { steps?: unknown } | null
    const steps   = Array.isArray(journey?.steps) ? (journey!.steps as JourneyStep[]) : []
    const idx     = (run.current_step as number) ?? 0
    const step    = steps[idx]

    if (!step) {
      // No more steps → mark completed
      await supabaseAdmin
        .from('lead_bridge_journey_runs')
        .update({ status: 'completed', next_step_at: null })
        .eq('id', run.id as string)
      return
    }

    let nextDelayMs = 0
    let advanceTo   = idx + 1

    switch (step.type) {
      case 'send_whatsapp': {
        await this.waTrigger.sendForConversion(run.conversion_id as string, step.message)
        break
      }
      case 'wait_hours': {
        nextDelayMs = step.hours * 3600_000
        break
      }
      case 'wait_days': {
        nextDelayMs = step.days * 86_400_000
        break
      }
      case 'branch_by_engagement': {
        const { data: conv } = await supabaseAdmin
          .from('lead_bridge_conversions')
          .select('journey_messages_sent')
          .eq('id', run.conversion_id as string)
          .maybeSingle()
        const sent = (conv?.journey_messages_sent as number | null) ?? 0
        advanceTo = idx + (sent >= step.threshold ? step.if_above : step.if_below)
        break
      }
      default:
        // Unknown step type → skip
        break
    }

    await supabaseAdmin
      .from('lead_bridge_journey_runs')
      .update({
        current_step: advanceTo,
        next_step_at: new Date(Date.now() + nextDelayMs).toISOString(),
      })
      .eq('id', run.id as string)
  }
}
