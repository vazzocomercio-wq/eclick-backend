import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ExecutiveAdsService } from './executive-ads.service'

/**
 * F11 E5 — cron de refresh do agregado Ads.
 *
 * Hourly (:37) — refresh do ml_ads_summary pra cada org com ads ativo.
 * Sem chamadas ML — só lê ml_ads_campaigns + ml_ads_reports que o módulo
 * ml-ads já popula via seu próprio cron de sync.
 */
@Injectable()
export class ExecutiveAdsCron {
  private readonly logger = new Logger(ExecutiveAdsCron.name)

  constructor(private readonly ads: ExecutiveAdsService) {}

  /** :37 cada hora — refresh do summary pra todas as orgs com ads. */
  @Cron('37 * * * *', { name: 'adsHourlySummary' })
  async refreshAll(): Promise<void> {
    const t0 = Date.now()
    const orgs = await this.fetchOrgsWithAds()
    if (orgs.length === 0) {
      this.logger.log('[ads.cron] nenhuma org com ads — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const orgId of orgs) {
      try {
        await this.ads.refreshSummary(orgId)
        ok++
      } catch (err) {
        this.logger.warn(`[ads.cron] ✗ org=${orgId.slice(0,8)}: ${(err as Error).message}`)
        fail++
      }
    }
    this.logger.log(
      `[ads.cron] refresh concluído: ${ok}/${orgs.length} ok, ` +
      `${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }

  private async fetchOrgsWithAds(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('ml_ads_campaigns')
      .select('organization_id')
    const set = new Set<string>()
    for (const r of ((data ?? []) as Array<{ organization_id: string }>)) {
      if (r.organization_id) set.add(r.organization_id)
    }
    return Array.from(set)
  }
}
