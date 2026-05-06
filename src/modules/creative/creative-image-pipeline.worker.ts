import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'

/**
 * Worker async pra pipeline de imagens. Pattern espelha o ads-sync.worker
 * do projeto Active: setInterval-based, lock in-process via flag `busy`.
 *
 * Cada tick:
 *   1. claimNextJob() — atomicamente pega 1 job 'queued' (ou null)
 *   2. processJob()   — gera prompts → N imagens → finalize
 *   3. Loop de novo até esvaziar a fila ou bater limite de ticks/run
 *
 * Desativável via env: DISABLE_CREATIVE_IMAGE_WORKER=true (dev local
 * geralmente desliga pra não estourar OpenAI por engano).
 *
 * Boot delay 30s evita correr antes do app estar pronto + afasta de
 * outros workers que sobem no mesmo node.
 */
@Injectable()
export class CreativeImagePipelineWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreativeImagePipelineWorker.name)
  private readonly tickIntervalMs = 5_000   // poll a cada 5s
  private readonly bootDelayMs    = 30_000  // espera 30s pós-boot
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly pipeline: CreativeImagePipelineService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_CREATIVE_IMAGE_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_CREATIVE_IMAGE_WORKER=true)')
      return
    }
    this.logger.log(`worker agendado — boot delay ${this.bootDelayMs / 1000}s, tick ${this.tickIntervalMs / 1000}s`)
    setTimeout(() => {
      // Primeiro tick imediato pós-delay, depois recorrente
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
      // Esvazia a fila enquanto houver — mas com guard rail (max 5 jobs/tick)
      // pra evitar travar o tick em caso de fila muito cheia.
      let drained = 0
      while (drained < 5) {
        const job = await this.pipeline.claimNextJob()
        if (!job) break
        this.logger.log(`processando job ${job.id} (count=${job.requested_count})`)
        await this.pipeline.processJob(job.id)
        drained += 1
      }
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
