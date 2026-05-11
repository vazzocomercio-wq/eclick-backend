import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ExecutiveLogisticsService } from './executive-logistics.service'

/**
 * F11 E3 — crons de logística.
 *
 * Cadência:
 *   - dailyScan (03:30 BRT): scan completo de delays + flex pra todas as
 *     (org, seller). Pesado: ~2000 shipments × 1 call + ~100 items × 1 call.
 *     Estimativa ~3-5min por seller.
 *   - hourlySummaryRefresh (:23): só agrega summary do que tem no DB
 *     (sem ML calls). Mantém dashboard com latência baixa.
 *
 * Watchdog Promise.race 15min por seller pra impedir scan zumbi.
 */
@Injectable()
export class ExecutiveLogisticsCron {
  private readonly logger = new Logger(ExecutiveLogisticsCron.name)

  constructor(private readonly logistics: ExecutiveLogisticsService) {}

  /** 03:30 BRT — full scan diário. */
  @Cron('30 6 * * *', { name: 'logisticsDailyScan', timeZone: 'America/Sao_Paulo' })
  async dailyScan(): Promise<void> {
    const t0 = Date.now()
    const sellers = await this.fetchAllSellers()
    if (sellers.length === 0) {
      this.logger.log('[logistics.cron] nenhuma seller — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        await this.runWithTimeout(async () => {
          const delays = await this.logistics.scanDelays(orgId, sellerId)
          const flex   = await this.logistics.scanFlex(orgId, sellerId)
          await this.logistics.refreshSummary(orgId, sellerId)
          this.logger.log(
            `[logistics.cron] org=${orgId.slice(0,8)} seller=${sellerId} ` +
            `delays(checked=${delays.shipments_checked} found=${delays.delays_found} auto_resolved=${delays.auto_resolved}) ` +
            `flex(checked=${flex.items_checked} eligible=${flex.flex_eligible})`,
          )
        }, 15 * 60_000)
        ok++
      } catch (err) {
        this.logger.warn(`[logistics.cron] ✗ org=${orgId.slice(0,8)} seller=${sellerId}: ${(err as Error).message}`)
        fail++
      }
    }
    this.logger.log(
      `[logistics.cron] daily scan concluído: ${ok}/${sellers.length} ok, ` +
      `${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }

  /** :23 de cada hora — só agrega summary (sem ML calls). */
  @Cron('23 * * * *', { name: 'logisticsHourlySummary' })
  async hourlySummary(): Promise<void> {
    const sellers = await this.fetchAllSellers()
    for (const { orgId, sellerId } of sellers) {
      try {
        await this.logistics.refreshSummary(orgId, sellerId)
      } catch (err) {
        this.logger.warn(`[logistics.cron] summary ✗ seller=${sellerId}: ${(err as Error).message}`)
      }
    }
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
