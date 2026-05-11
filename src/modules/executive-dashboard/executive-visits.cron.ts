import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ExecutiveVisitsService } from './executive-visits.service'

/**
 * F11 E4 — cron diário de visitas.
 *
 * Cadência: 03:00 BRT — sync de últimos 7 dias (cobre janela útil pro
 * dashboard + ajusta dia anterior caso visit count tenha subido depois
 * do meio-dia da janela parcial).
 */
@Injectable()
export class ExecutiveVisitsCron {
  private readonly logger = new Logger(ExecutiveVisitsCron.name)

  constructor(private readonly visits: ExecutiveVisitsService) {}

  /** 03:00 BRT — sync diário de visitas pra todas as (org, seller). */
  @Cron('0 6 * * *', { name: 'visitsDailySync', timeZone: 'America/Sao_Paulo' })
  async syncAll(): Promise<void> {
    const t0 = Date.now()
    const sellers = await this.fetchAllSellers()
    if (sellers.length === 0) {
      this.logger.log('[visits.cron] nenhuma seller — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        const r = await this.visits.syncRecent(orgId, sellerId, 7)
        this.logger.log(
          `[visits.cron] org=${orgId.slice(0,8)} seller=${sellerId} days_synced=${r.days_synced} total=${r.total_visits}`,
        )
        ok++
      } catch (err) {
        this.logger.warn(`[visits.cron] ✗ seller=${sellerId}: ${(err as Error).message}`)
        fail++
      }
    }
    this.logger.log(
      `[visits.cron] sync concluído: ${ok}/${sellers.length} ok, ` +
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
