import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { SocialCommerceService } from './social-commerce.service'

/**
 * Onda 3 / S2 — Sync worker de social commerce.
 *
 * A cada 60 minutos, pega produtos com sync_status='pending' ou 'error' de
 * canais conectados e tenta sincronizar via Meta Catalog API.
 *
 * Tick: 60min (configurável por canal — ver config.sync_interval_minutes).
 * Max: 20 produtos/tick (suficiente pra ~1k produtos/dia).
 * Boot delay: 120s (sobe depois dos workers de IA criativa).
 *
 * Kill-switch: DISABLE_SOCIAL_COMMERCE_WORKER=true.
 *
 * Em prod, idealmente este worker chama o helper paralelizado da
 * SocialCommerceService (TODO: bulk sync com batch de 50 itens em uma
 * chamada Graph API ao invés de 1-por-1 como está hoje).
 */
@Injectable()
export class SocialCommerceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger        = new Logger(SocialCommerceWorker.name)
  private readonly tickIntervalMs = 60 * 60 * 1_000   // 60min
  private readonly bootDelayMs    = 120_000           // 2min
  private readonly maxPerTick     = 20
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly svc: SocialCommerceService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_SOCIAL_COMMERCE_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_SOCIAL_COMMERCE_WORKER=true)')
      return
    }
    if (!process.env.META_APP_ID) {
      this.logger.warn('META_APP_ID não setado — worker em standby (não tickará)')
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
      const pending = await this.svc.listPendingSyncs(this.maxPerTick)
      if (pending.length === 0) return
      this.logger.log(`processando ${pending.length} produto(s) pending`)
      for (const p of pending) {
        try {
          if (p.channel === 'instagram_shop') {
            await this.svc.syncProduct(p.organization_id, p.product_id)
          }
          // Outros canais (tiktok_shop, google_shopping) — futuras sprints
        } catch (e: unknown) {
          this.logger.warn(`sync ${p.product_id}@${p.channel} falhou: ${(e as Error).message}`)
        }
      }
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
