import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ProductsEnrichmentService } from './products-enrichment.service'

/**
 * Onda 1 / M2.2 — Worker de enriquecimento automático.
 *
 * Quando o trigger DB seta ai_enrichment_pending=true (em INSERT ou UPDATE
 * de campos chave), este worker pega na próxima passada e chama Sonnet.
 *
 * Tick: 5min. Max 5 produtos/tick → cap natural de custo (~$3/hora teto
 * absoluto, mas na prática 10-50 mudanças/dia = ~$0.20-1/dia).
 *
 * Boot delay: 90s (último a subir, deixa workers de IA criativa
 * iniciarem primeiro).
 *
 * Kill-switch: DISABLE_PRODUCTS_ENRICHMENT_WORKER=true (dev local
 * geralmente desliga pra não chamar Sonnet por engano).
 */
@Injectable()
export class ProductsEnrichmentWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductsEnrichmentWorker.name)
  private readonly tickIntervalMs = 5 * 60 * 1_000  // 5 min
  private readonly bootDelayMs    = 90_000          // 90s
  private readonly maxPerTick     = 5
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly enrichment: ProductsEnrichmentService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_PRODUCTS_ENRICHMENT_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_PRODUCTS_ENRICHMENT_WORKER=true)')
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
      const pending = await this.enrichment.listPendingEnrichment(this.maxPerTick)
      if (pending.length === 0) return
      this.logger.log(`processando ${pending.length} produto(s) pending`)
      for (const p of pending) {
        try {
          await this.enrichment.enrichProduct(p.organization_id, p.id)
        } catch (e: unknown) {
          this.logger.warn(`enrich ${p.id} falhou: ${(e as Error).message}`)
          // enrichProduct já limpa pending=false em erro, segue pro próximo
        }
      }
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
