import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { OrganicCollectorService } from './organic-collector.service'

/**
 * Worker do coletor orgânico. Roda de 6 em 6h: pra cada org com IG conectado,
 * puxa o feed + insights. Idempotente (upsert).
 *
 * Kill-switch `DISABLE_ANALYTICS_ORGANIC_WORKER=true`. ⚠️ Operacional: o
 * eclick-workers roda o mesmo AppModule — setar o kill-switch lá pra coletar
 * só no eclick-backend e não duplicar chamadas à Graph API (igual ao worker
 * de vídeo do creative).
 */
@Injectable()
export class OrganicCollectorWorker {
  private readonly logger = new Logger(OrganicCollectorWorker.name)
  private running = false

  constructor(private readonly collector: OrganicCollectorService) {}

  @Cron(CronExpression.EVERY_6_HOURS, { name: 'analytics-organic-collect' })
  async tick(): Promise<void> {
    if (process.env.DISABLE_ANALYTICS_ORGANIC_WORKER === 'true') return
    if (this.running) {
      this.logger.warn('[organic] tick anterior ainda rodando — pulo')
      return
    }
    this.running = true
    try {
      const orgs = await this.collector.orgsWithInstagram()
      this.logger.log(`[organic] coletando ${orgs.length} org(s) com IG`)
      for (const orgId of orgs) {
        try {
          const s = await this.collector.collectForOrg(orgId)
          this.logger.log(
            `[organic] org ${orgId}: ${s.posts} posts (${s.with_insights} c/ insights, ${s.without_insights} s/), ${s.accounts} conta(s)`,
          )
        } catch (err) {
          this.logger.error(`[organic] org ${orgId} falhou: ${String(err)}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}
