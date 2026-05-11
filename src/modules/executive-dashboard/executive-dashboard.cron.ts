import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ExecutiveDashboardService } from './executive-dashboard.service'

/**
 * Cron periódico do F11. Refresh full do `ml_dashboard_summary` pra
 * todas as orgs / sellers conectados.
 *
 * Cadência:
 *  - every15min — refresh full (lê VIEW, faz UPSERT). Sem chamadas ML;
 *    tudo do Postgres.
 *
 * Watchdog Promise.race 5min por seller pra impedir refresh zumbi.
 * Tempo real de vendas (<3s) é coberto pelo `?fresh=sales` no endpoint
 * + Socket.IO subscriber no frontend — não precisa cron mais rápido.
 */
@Injectable()
export class ExecutiveDashboardCron {
  private readonly logger = new Logger(ExecutiveDashboardCron.name)

  constructor(private readonly dashboard: ExecutiveDashboardService) {}

  /** A cada 15 min — refresh full de todas as (org, seller). */
  @Cron('*/15 * * * *', { name: 'dashboardRefreshAll' })
  async refreshAll(): Promise<void> {
    const t0 = Date.now()
    const sellers = await this.fetchAllSellers()
    if (sellers.length === 0) {
      this.logger.log('[dashboard.cron] nenhuma seller conectada — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        await this.runWithTimeout(
          () => this.dashboard.refresh(orgId, sellerId),
          5 * 60_000,
        )
        ok++
      } catch (err) {
        this.logger.warn(
          `[dashboard.cron] ✗ org=${orgId.slice(0,8)} seller=${sellerId}: ${(err as Error).message}`,
        )
        fail++
      }
    }
    this.logger.log(
      `[dashboard.cron] refresh concluído: ${ok}/${sellers.length} ok, ` +
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
