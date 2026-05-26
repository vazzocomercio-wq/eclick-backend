import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { GeoRadarService } from './geo-radar.service'

/**
 * Worker do GEO Radar. Roda SEMANALMENTE (visibilidade em IA muda devagar e
 * cada rodada custa créditos). Pra cada org com queries ativas, mede presença
 * nos 3 motores. Kill-switch `DISABLE_ANALYTICS_GEO_RADAR_WORKER`.
 * ⚠️ Operacional: setar o kill-switch no eclick-workers (mesmo AppModule) pra
 * não rodar 2x e dobrar o gasto com IA.
 */
@Injectable()
export class GeoRadarWorker {
  private readonly logger = new Logger(GeoRadarWorker.name)
  private running = false

  constructor(private readonly radar: GeoRadarService) {}

  @Cron(CronExpression.EVERY_WEEK, { name: 'analytics-geo-radar' })
  async tick(): Promise<void> {
    if (process.env.DISABLE_ANALYTICS_GEO_RADAR_WORKER === 'true') return
    if (this.running) return
    this.running = true
    try {
      const orgs = await this.radar.orgsWithQueries()
      this.logger.log(`[geo-radar] medindo ${orgs.length} org(s)`)
      for (const orgId of orgs) {
        try {
          const s = await this.radar.run(orgId)
          this.logger.log(`[geo-radar] org ${orgId}: ${s.runs} medições, ${s.mentioned} menções, $${s.cost_usd.toFixed(2)}`)
        } catch (err) {
          this.logger.error(`[geo-radar] org ${orgId} falhou: ${String(err)}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}
