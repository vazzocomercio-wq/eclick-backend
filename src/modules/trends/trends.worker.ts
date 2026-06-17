import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { TrendsService } from './trends.service'

/** F-Trends Fase 1 — coleta diária pras orgs com auto_enabled=true.
 *  Roda 05:10 (horário do servidor). Coleta sequencial por org pra não
 *  estourar rate limit do ML. Manual continua via POST /trends/collect. */
@Injectable()
export class TrendsWorker {
  private readonly logger = new Logger(TrendsWorker.name)
  private running = false

  constructor(private readonly trends: TrendsService) {}

  @Cron('10 5 * * *', { name: 'trends-daily-collect' })
  async dailyCollect(): Promise<void> {
    if (this.running) { this.logger.warn('[trends.cron] já rodando, pulando'); return }
    this.running = true
    try {
      const orgs = await this.trends.autoEnabledOrgs()
      this.logger.log(`[trends.cron] coleta diária — ${orgs.length} org(s) com auto_enabled`)
      for (const orgId of orgs) {
        try {
          const r = await this.trends.collectAndScore(orgId)
          this.logger.log(`[trends.cron] org=${orgId} → ${r.bestSellers} best-sellers, ${r.scored} scored`)
        } catch (e) {
          this.logger.error(`[trends.cron] org=${orgId} falhou: ${e instanceof Error ? e.message : e}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}
