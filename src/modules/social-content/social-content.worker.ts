import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { SocialContentService } from './social-content.service'

/**
 * Onda 3 / S1 — Worker de publicação de peças agendadas.
 *
 * Tick: 5min. Pega peças `status='scheduled'` cujo `scheduled_at <= now()`
 * em canais publicáveis (hoje só `whatsapp_broadcast` via bridge Active).
 * Outros canais ficam pra sprints futuras (IG Graph publish, etc.).
 *
 * Boot delay: 150s.
 * Kill-switch: DISABLE_SOCIAL_CONTENT_WORKER=true
 * Standby: se ACTIVE_AUTOMATION_BRIDGE_URL não estiver setado, fica idle.
 */
@Injectable()
export class SocialContentWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocialContentWorker.name)
  private readonly tickIntervalMs = 5 * 60 * 1_000   // 5min
  private readonly bootDelayMs    = 150_000          // 2.5min
  private readonly maxPerTick     = 20
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly svc: SocialContentService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SOCIAL_CONTENT_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_SOCIAL_CONTENT_WORKER=true)')
      return
    }
    if (!process.env.ACTIVE_AUTOMATION_BRIDGE_URL) {
      this.logger.warn('ACTIVE_AUTOMATION_BRIDGE_URL não setado — worker em standby')
      return
    }
    this.logger.log(`worker agendado — boot delay ${this.bootDelayMs / 1000}s, tick ${this.tickIntervalMs / 60_000}min`)
    setTimeout(() => {
      void this.tick()
      this.timer = setInterval(() => void this.tick(), this.tickIntervalMs)
    }, this.bootDelayMs)
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const due = await this.svc.listDueScheduled(this.maxPerTick)
      if (due.length === 0) return
      this.logger.log(`processando ${due.length} peça(s) agendada(s) vencida(s)`)
      for (const item of due) {
        try {
          await this.svc.publishContent(item.id, item.organization_id)
        } catch (e) {
          this.logger.warn(`publish ${item.id} falhou: ${(e as Error).message}`)
        }
      }
    } catch (e) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
