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
      const autoOrgs = await this.trends.autoEnabledOrgs()
      this.logger.log(`[trends.cron] coleta diária — ${autoOrgs.length} org(s) com auto_enabled`)
      for (const orgId of autoOrgs) {
        try {
          const r = await this.trends.collectAndScore(orgId)
          this.logger.log(`[trends.cron] org=${orgId} → ${r.bestSellers} best-sellers, ${r.scored} scored`)
        } catch (e) {
          this.logger.error(`[trends.cron] org=${orgId} falhou: ${e instanceof Error ? e.message : e}`)
        }
      }

      // produtos OBSERVADOS (watchlist) refrescam todo dia, mesmo fora das
      // categorias escaneadas — acumula preço/visitas na página deles.
      const watchOrgs = (await this.trends.orgsWithWatchlist()).filter(o => !autoOrgs.includes(o))
      this.logger.log(`[trends.cron] refresh watchlist — ${watchOrgs.length} org(s)`)
      for (const orgId of watchOrgs) {
        try {
          const r = await this.trends.refreshWatchlist(orgId)
          this.logger.log(`[trends.cron] watchlist org=${orgId} → ${r.refreshed} produtos`)
        } catch (e) {
          this.logger.error(`[trends.cron] watchlist org=${orgId} falhou: ${e instanceof Error ? e.message : e}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}
