import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { CreativeVideoPipelineService } from './creative-video-pipeline.service'

/**
 * Worker async pra pipeline de vídeos via Kling.
 *
 * Diferente do worker de imagens (E2): Kling é assíncrono no provider —
 * cada vídeo demora 60-180s pra renderizar. Worker pollea status a cada
 * tick. Múltiplos ticks são esperados pra cada job.
 *
 * Cada tick:
 *   1. Lista jobs ativos (queued / generating_*) — máx 5
 *   2. Pra cada job: processJob() que avança 1 passo do estado
 *      - Sem prompts → gera prompts
 *      - Com pendentes → submete pro Kling em paralelo
 *      - Com generating → pollea Kling, baixa quando succeed
 *      - Tudo done → finalize
 *
 * Tick 8s (intervalo maior que imagens — Kling render demora minutos).
 * Boot delay 35s pra esperar o app subir.
 *
 * Kill-switch: DISABLE_CREATIVE_VIDEO_WORKER=true
 */
@Injectable()
export class CreativeVideoPipelineWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreativeVideoPipelineWorker.name)
  private readonly tickIntervalMs = 8_000
  private readonly bootDelayMs    = 35_000
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly pipeline: CreativeVideoPipelineService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_CREATIVE_VIDEO_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_CREATIVE_VIDEO_WORKER=true)')
      return
    }
    this.logger.log(`worker agendado — boot delay ${this.bootDelayMs / 1000}s, tick ${this.tickIntervalMs / 1000}s`)
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
      const active = await this.pipeline.listActiveJobs(5)
      if (active.length === 0) return
      // Sequencial por job (cada processJob é fast — ~1-3s) pra evitar lock contention
      for (const job of active) {
        await this.pipeline.processJob(job.id)
      }
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
