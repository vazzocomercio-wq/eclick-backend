import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { AdsCampaignsService } from './ads-campaigns.service'

/**
 * Onda 3 / S6 — Worker de sync de métricas de Ads.
 *
 * Tick: 6h. Pega até 30 campanhas active/publishing por ciclo e sincroniza
 * métricas (impressions/clicks/spend/conversions/roas) das plataformas.
 *
 * Por ora só Meta — Google/TikTok ficam pra sprints futuras.
 *
 * Boot delay: 180s.
 * Kill-switch: DISABLE_ADS_METRICS_WORKER=true.
 * Standby: se META_APP_ID não setado, fica idle (sem tick).
 */
@Injectable()
export class AdsMetricsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdsMetricsWorker.name)
  private readonly tickIntervalMs = 6 * 60 * 60 * 1_000  // 6h
  private readonly bootDelayMs    = 180_000              // 3min
  private readonly maxPerTick     = 30
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(private readonly svc: AdsCampaignsService) {}

  onModuleInit(): void {
    if (process.env.DISABLE_ADS_METRICS_WORKER === 'true') {
      this.logger.warn('worker DESLIGADO (DISABLE_ADS_METRICS_WORKER=true)')
      return
    }
    if (!process.env.META_APP_ID) {
      this.logger.warn('META_APP_ID não setado — worker em standby')
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
      const campaigns = await this.svc.listForMetricsSync(this.maxPerTick)
      if (campaigns.length === 0) return
      this.logger.log(`processando ${campaigns.length} campanha(s)`)
      for (const c of campaigns) {
        if (c.platform !== 'meta') continue
        try {
          await this.svc.syncMetrics(c.id, c.organization_id)
        } catch (e: unknown) {
          this.logger.warn(`sync ${c.id} falhou: ${(e as Error).message}`)
        }
      }
    } catch (e: unknown) {
      this.logger.error(`tick falhou: ${(e as Error).message}`)
    } finally {
      this.busy = false
    }
  }
}
