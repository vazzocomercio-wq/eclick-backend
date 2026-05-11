import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MlListingService } from './ml-listing.service'

/**
 * Cron periódico do F10. Roda full scan automático pra todas as orgs
 * conectadas, pra cada seller_id. Sem isso, módulo é puramente manual
 * (operador precisa clicar "Scan completo" todo dia).
 *
 * Cadência:
 *  - dailyFullScan (cron 30 02 * * * BRT): full scan completo
 *    pra todas (agg+stock+status+pricing+catalog+automation+fiscal).
 *    Latência ~6-9min por seller Vazzo.
 *  - hourlyAggregation (cron @17min): só agregação (lê VIEW, sem ML).
 *    Mantém tasks F7/F8/F9 atualizadas em latência baixa.
 *
 * Watchdog Promise.race 15min por seller pra impedir scan zumbi
 * derrubar o cron inteiro. Multi-conta automático via getAllTokensForOrg.
 */
@Injectable()
export class ListingScansCron {
  private readonly logger = new Logger(ListingScansCron.name)

  constructor(private readonly listing: MlListingService) {}

  /** 02:30 BRT — full scan completo de todas as orgs conectadas. */
  @Cron('30 5 * * *', { name: 'listingDailyFullScan', timeZone: 'America/Sao_Paulo' })
  async dailyFullScan(): Promise<void> {
    const t0 = Date.now()
    this.logger.log(`[listing.cron] iniciando daily full scan at ${new Date().toISOString()}`)

    const sellers = await this.fetchAllSellers()
    if (sellers.length === 0) {
      this.logger.log('[listing.cron] nenhuma seller conectada — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        const result = await this.runWithTimeout(
          () => this.listing.runFullScan(orgId, sellerId),
          15 * 60_000,
        )
        this.logger.log(
          `[listing.cron] ✓ full org=${orgId.slice(0,8)} seller=${sellerId} ` +
          `tasks_created=${result.tasks_created} duration=${result.duration_seconds}s`,
        )
        ok++
      } catch (err) {
        this.logger.error(`[listing.cron] ✗ full org=${orgId.slice(0,8)} seller=${sellerId}: ${(err as Error).message}`)
        fail++
      }
    }
    this.logger.log(
      `[listing.cron] daily full scan concluído: ${ok}/${sellers.length} ok, ` +
      `${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }

  /** @17min de cada hora — só agregação (rápido, sem ML calls).
   *  Mantém tasks agregadas do F7/F8/F9 atualizadas pra UI ficar viva. */
  @Cron('17 * * * *', { name: 'listingHourlyAggregation', timeZone: 'America/Sao_Paulo' })
  async hourlyAggregation(): Promise<void> {
    const t0 = Date.now()
    this.logger.log(`[listing.cron] iniciando hourly aggregation at ${new Date().toISOString()}`)

    const sellers = await this.fetchAllSellers()
    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        await this.runWithTimeout(
          () => this.listing.runAggregationOnly(orgId, sellerId),
          3 * 60_000,
        )
        ok++
      } catch (err) {
        this.logger.warn(`[listing.cron] ✗ agg org=${orgId.slice(0,8)} seller=${sellerId}: ${(err as Error).message}`)
        fail++
      }
    }
    this.logger.log(
      `[listing.cron] hourly aggregation concluído: ${ok}/${sellers.length} ok, ` +
      `${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }

  private async fetchAllSellers(): Promise<Array<{ orgId: string; sellerId: number }>> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id, seller_id')
      .not('organization_id', 'is', null)
    return ((data ?? []) as Array<{ organization_id: string; seller_id: number }>)
      .map(c => ({ orgId: c.organization_id, sellerId: c.seller_id }))
  }

  private async runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Watchdog timeout (>${Math.round(timeoutMs / 60_000)}min)`)), timeoutMs),
      ),
    ])
  }
}
