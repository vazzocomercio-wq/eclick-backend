import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'
import { CreativeVideoPipelineService } from './creative-video-pipeline.service'

/**
 * Worker de limpeza — recupera jobs/imagens/vídeos presos em estados
 * intermediários (`generating_*` / `generating`) por tempo excessivo.
 *
 * Cenários típicos que travam state:
 *   - Backend reinicia mid-execução (Railway redeploy, OOM)
 *   - Processo do worker morre antes de completar
 *   - Bug não tratado em alguma branch do pipeline
 *
 * Tick: 1h. Não precisa ser frequente — recupera dentro de até 1h o que
 * ficou preso. Suficiente pra a UI parar de mostrar "gerando..." infinito.
 *
 * Boot delay: 90s (último a subir).
 *
 * Kill-switch: DISABLE_CREATIVE_CLEANUP_WORKER=true
 */
@Injectable()
export class CreativeCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreativeCleanupWorker.name)
  private readonly tickIntervalMs = 60 * 60 * 1_000  // 1h
  private readonly bootDelayMs    = 90_000
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(
    private readonly images: CreativeImagePipelineService,
    private readonly videos: CreativeVideoPipelineService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_CREATIVE_CLEANUP_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_CREATIVE_CLEANUP_WORKER=true)')
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
      const [imgRes, vidRes] = await Promise.all([
        this.images.cleanupStale().catch(e => {
          this.logger.error(`images cleanup falhou: ${(e as Error).message}`)
          return { jobsFailed: 0, imagesFailed: 0 }
        }),
        this.videos.cleanupStale().catch(e => {
          this.logger.error(`videos cleanup falhou: ${(e as Error).message}`)
          return { jobsFailed: 0, videosFailed: 0 }
        }),
      ])
      const total = imgRes.jobsFailed + imgRes.imagesFailed + vidRes.jobsFailed + vidRes.videosFailed
      if (total > 0) {
        this.logger.log(`tick limpou: img=${imgRes.jobsFailed}j+${imgRes.imagesFailed}i, vid=${vidRes.jobsFailed}j+${vidRes.videosFailed}v`)
      }
    } finally {
      this.busy = false
    }
  }
}
