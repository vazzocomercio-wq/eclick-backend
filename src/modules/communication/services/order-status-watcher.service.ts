import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

interface JourneyStepRow {
  step?:           number
  trigger?:        string
  condition?:      { shipping_status?: string } | Record<string, unknown>
  delay_minutes?:  number
  template_name?:  string
  template_kind?:  string
  channel_priority?: string
}

/** CC-3 — watcher de mudança de status do pedido pra desbloquear runs
 * paused (next_step_at=null) em steps com trigger='status_change_ml'
 * ou 'time_offset'. Idempotente: se condition já está atendida, set
 * next_step_at=now() pro cron CC-2 pegar e processar. Sem dedup —
 * CC-2 dedupa via current_step.
 *
 * Multi-tenant: opera em todas as orgs (sem filtro). Cron @5min é o
 * gatilho principal; triggerOrderEvent (no JourneyEngineService) é a
 * porta de saída pra eventos imediatos (webhook ML, UPDATE manual). */
@Injectable()
export class OrderStatusWatcherService {
  private readonly logger = new Logger(OrderStatusWatcherService.name)
  private isRunning = false

  @Cron('*/5 * * * *', { name: 'orderStatusWatcherTick' })
  async watchOrderStatusChanges(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    try {
      const r = await this.tick()
      if (r.checked > 0) {
        this.logger.log(`[CC-3.tick] ${r.checked} runs checadas, ${r.unblocked} desbloqueadas`)
      }
    } catch (e: unknown) {
      this.logger.error(`[CC-3.tick] erro: ${(e as Error)?.message ?? '?'}`)
    } finally {
      this.isRunning = false
    }
  }

  /** Exposto pra POST admin (futuro) e testes. Retorna {checked, unblocked}. */
  async tick(): Promise<{ checked: number; unblocked: number }> {
    // Busca runs paused com order_id (não trata runs sem order — não tem
    // o que watchear). Cap 500 por tick pra evitar travada em orgs grandes.
    const { data: runs, error } = await supabaseAdmin
      .from('messaging_journey_runs')
      .select('id, journey_id, order_id, current_step, organization_id, context, updated_at')
      .eq('status', 'pending')
      .is('next_step_at', null)
      .not('order_id', 'is', null)
      .limit(500)

    if (error) {
      this.logger.error(`[CC-3.fetch] ${error.message}`)
      return { checked: 0, unblocked: 0 }
    }
    if (!runs?.length) return { checked: 0, unblocked: 0 }

    let unblocked = 0
    for (const run of runs) {
      try {
        const did = await this.processRun(run as Record<string, Json>)
        if (did) unblocked++
      } catch (e: unknown) {
        this.logger.warn(`[CC-3.run] run=${run.id} erro: ${(e as Error)?.message ?? '?'}`)
      }
    }
    return { checked: runs.length, unblocked }
  }

  private async processRun(run: Record<string, Json>): Promise<boolean> {
    // Step atual da journey
    const { data: journey } = await supabaseAdmin
      .from('messaging_journeys')
      .select('steps, is_active')
      .eq('id', run.journey_id)
      .maybeSingle()
    if (!journey?.is_active) return false
    const steps = (journey.steps ?? []) as JourneyStepRow[]
    const step  = steps[run.current_step as number]
    if (!step) return false

    if (step.trigger === 'status_change_ml') {
      return await this.handleStatusChangeMl(run, step)
    }
    if (step.trigger === 'time_offset') {
      return await this.handleTimeOffset(run, step)
    }
    return false
  }

  private async handleStatusChangeMl(run: Record<string, Json>, step: JourneyStepRow): Promise<boolean> {
    const cond     = (step.condition ?? {}) as { shipping_status?: string }
    const expected = cond.shipping_status
    if (!expected) return false

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('shipping_status')
      .eq('external_order_id', run.order_id as string)
      .maybeSingle()
    const actual = (order?.shipping_status as string | null | undefined) ?? null

    const matches = actual != null && String(actual).toLowerCase() === String(expected).toLowerCase()
    const action  = matches ? 'unblocked' : 'waiting'
    this.logger.log(
      `[CC-3.watcher] run=${run.id} order=${run.order_id} current_step=${run.current_step} expected=${expected} actual=${actual ?? 'null'} action=${action}`,
    )
    if (!matches) return false

    await supabaseAdmin
      .from('messaging_journey_runs')
      .update({ next_step_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', run.id as string)
    return true
  }

  private async handleTimeOffset(run: Record<string, Json>, step: JourneyStepRow): Promise<boolean> {
    // Caso anormal: engine CC-2 normalmente seta next_step_at=now+delay
    // (não null) pra time_offset. Se chegou aqui (next_step_at=null), é
    // recovery — usa __armed_step_${idx} ou updated_at como base.
    const delayMs = (Number(step.delay_minutes) || 0) * 60_000
    const ctx = (run.context ?? {}) as Record<string, unknown>
    const armedKey = `__armed_step_${run.current_step}`
    const baseIso  = (ctx[armedKey] as string | undefined) ?? (run.updated_at as string | undefined)
    const baseMs   = baseIso ? new Date(baseIso).getTime() : Date.now()
    const elapsed  = Date.now() - baseMs

    const matches = elapsed >= delayMs
    const action  = matches ? 'unblocked' : 'waiting'
    this.logger.log(
      `[CC-3.watcher] run=${run.id} order=${run.order_id} current_step=${run.current_step} time_offset delay_min=${step.delay_minutes ?? 0} elapsed_min=${Math.round(elapsed / 60_000)} action=${action}`,
    )
    if (!matches) return false

    await supabaseAdmin
      .from('messaging_journey_runs')
      .update({ next_step_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', run.id as string)
    return true
  }
}
