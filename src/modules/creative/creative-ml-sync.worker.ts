import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { CreativeMlPublisherService } from './creative-ml-publisher.service'

/**
 * Worker F4 — sync periódico de status das publications do ML.
 *
 * Pra cada publication com status='published' e last_synced_at antigo
 * (>30min) ou nulo, faz GET /items/{external_id} no ML e atualiza
 * last_synced_status (active/paused/closed/under_review/inactive).
 *
 * Tick: 10min — ML rate-limit é 10k req/h por seller, com 20 sync/tick
 * fica em ~120/h por seller. Suficiente.
 *
 * Boot delay: 60s (espera demais workers iniciarem primeiro).
 *
 * Kill-switch: DISABLE_CREATIVE_ML_SYNC_WORKER=true
 */
@Injectable()
export class CreativeMlSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreativeMlSyncWorker.name)
  private readonly tickIntervalMs = 10 * 60 * 1_000  // 10 min
  private readonly bootDelayMs    = 60_000
  private readonly maxItemsPerTick = 20
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly mlPub: CreativeMlPublisherService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_CREATIVE_ML_SYNC_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_CREATIVE_ML_SYNC_WORKER=true)')
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
      const stale = await this.mlPub.listPublicationsForSync(this.maxItemsPerTick, 30)
      if (stale.length === 0) return
      this.logger.log(`processando ${stale.length} publications stale`)
      for (const pub of stale) {
        try {
          await this.mlPub.syncPublicationStatus(pub.organization_id, pub.id)
        } catch (e: unknown) {
          // Log e segue — uma falha não para o worker
          this.logger.warn(`sync ${pub.id} falhou: ${(e as Error).message}`)
        }
      }
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
