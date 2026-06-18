import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { ShopeeRadarService } from './shopee-radar.service'

/** Radar Shopee — ingestão diária pras orgs com auto ligado. Roda 05:30
 *  (após o radar ML 05:10). Acumula vendas/preço/score em offer_signals. */
@Injectable()
export class ShopeeRadarWorker {
  private readonly logger = new Logger(ShopeeRadarWorker.name)
  private running = false

  constructor(private readonly radar: ShopeeRadarService) {}

  @Cron('30 5 * * *', { name: 'shopee-radar-daily' })
  async daily(): Promise<void> {
    if (this.running) { this.logger.warn('[shopee.cron] já rodando, pulando'); return }
    this.running = true
    try {
      const orgs = await this.radar.autoIngestOrgs()
      this.logger.log(`[shopee.cron] ingestão diária — ${orgs.length} org(s)`)
      for (const { orgId, keywords } of orgs) {
        try {
          const r = await this.radar.ingest(orgId, { keywords: keywords.length ? keywords : undefined, pagesPerQuery: 2 })
          this.logger.log(`[shopee.cron] org=${orgId} → ${r.upserted} produtos`)
        } catch (e) {
          this.logger.error(`[shopee.cron] org=${orgId} falhou: ${e instanceof Error ? e.message : e}`)
        }
      }

      // produtos OBSERVADOS: re-busca por itemId (garante histórico mesmo fora
      // do top-vendas), pra TODA org que tenha observados.
      const watchOrgs = await this.radar.orgsWithWatched()
      this.logger.log(`[shopee.cron] refresh observados — ${watchOrgs.length} org(s)`)
      for (const orgId of watchOrgs) {
        try {
          const r = await this.radar.refreshWatched(orgId)
          this.logger.log(`[shopee.cron] observados org=${orgId} → ${r.refreshed}`)
        } catch (e) {
          this.logger.error(`[shopee.cron] observados org=${orgId} falhou: ${e instanceof Error ? e.message : e}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}
