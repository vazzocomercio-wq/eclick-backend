import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ProductsEnrichmentService } from './products-enrichment.service'

/**
 * Onda 1 hybrid C / Delta 2 — Worker dedicado pra batch enrichment jobs.
 *
 * Diferente do worker M2.2 (trigger-based, single product changes),
 * este pega jobs de `product_enrichment_jobs` e itera os product_ids.
 *
 * Tick: 30s (mais agressivo que M2.2 — bulks são opt-in pelo user).
 * Boot delay: 100s (depois dos workers de IA criativa + M2.2).
 *
 * Cada tick claima 1 job, processa todos os products (até max_cost_usd
 * estourar), finaliza. Não paraleliza entre jobs.
 *
 * Kill-switch: DISABLE_PRODUCTS_ENRICHMENT_BATCH_WORKER=true
 */
@Injectable()
export class ProductsEnrichmentBatchWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductsEnrichmentBatchWorker.name)
  private readonly tickIntervalMs = 30 * 1_000
  private readonly bootDelayMs    = 100_000
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly enrichment: ProductsEnrichmentService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_PRODUCTS_ENRICHMENT_BATCH_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_PRODUCTS_ENRICHMENT_BATCH_WORKER=true)')
      return
    }
    this.logger.log(`batch worker agendado — boot delay ${this.bootDelayMs / 1000}s, tick ${this.tickIntervalMs / 1000}s`)
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
      const job = await this.enrichment.claimNextEnrichmentJob()
      if (!job) return
      this.logger.log(`processando job ${job.id} — ${job.product_ids.length} produtos`)

      let costAccumulated = job.total_cost_usd ?? 0
      const startIdx = job.processed_count ?? 0
      const remaining = job.product_ids.slice(startIdx)

      for (const productId of remaining) {
        // Cost cap
        if (costAccumulated >= job.max_cost_usd) {
          this.logger.warn(`job ${job.id} max_cost_usd $${job.max_cost_usd} atingido — finalizando`)
          await this.enrichment.finalizeJob(job.id, 'failed', `Limite de custo $${job.max_cost_usd} atingido`)
          return
        }
        const r = await this.enrichment.processJobProduct(job.id, job.organization_id, productId)
        if (r.success) costAccumulated += r.cost
      }

      await this.enrichment.finalizeJob(job.id, 'completed')
      this.logger.log(`job ${job.id} ✓ completo`)
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
