import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { AffiliateAttributionService } from './affiliate-attribution.service'

@Injectable()
export class AffiliatesCron {
  private readonly logger = new Logger(AffiliatesCron.name)

  constructor(private readonly attribution: AffiliateAttributionService) {}

  /** Roda 05:00 BRT (08:00 UTC) — aprova comissões com refund_window
   *  vencido. Idempotente: UNIQUE no schema + filtro status='pending'. */
  @Cron('0 8 * * *')
  async dailyApprove() {
    try {
      const result = await this.attribution.approveExpiredCommissions()
      if (result.approved > 0) {
        this.logger.log(`[affiliate.cron] aprovou ${result.approved} comissões em ${result.orgsScanned} orgs`)
      }
    } catch (err) {
      this.logger.error(`[affiliate.cron] dailyApprove falhou: ${(err as Error).message}`)
    }
  }
}
