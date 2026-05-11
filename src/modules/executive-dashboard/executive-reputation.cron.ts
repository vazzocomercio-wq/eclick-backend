import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ExecutiveReputationService } from './executive-reputation.service'

/**
 * F11 E2 — cron hourly de reputação.
 *
 * Reputação muda lentamente (cumulativo 60d). Sync 1×/hora pra cada
 * (org, seller). 2 contas Vazzo = 2 calls ML/h = bem dentro do limite.
 */
@Injectable()
export class ExecutiveReputationCron {
  private readonly logger = new Logger(ExecutiveReputationCron.name)

  constructor(private readonly reputation: ExecutiveReputationService) {}

  /** :47 de cada hora — sync de reputação pra todas as (org, seller). */
  @Cron('47 * * * *', { name: 'reputationHourlySync' })
  async syncAll(): Promise<void> {
    const t0 = Date.now()
    const sellers = await this.fetchAllSellers()
    if (sellers.length === 0) {
      this.logger.log('[reputation.cron] nenhuma seller conectada — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        await this.reputation.syncReputation(orgId, sellerId)
        ok++
      } catch (err) {
        this.logger.warn(
          `[reputation.cron] ✗ org=${orgId.slice(0,8)} seller=${sellerId}: ${(err as Error).message}`,
        )
        fail++
      }
    }
    this.logger.log(
      `[reputation.cron] sync concluído: ${ok}/${sellers.length} ok, ` +
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
}
