import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { CashbackService } from './cashback.service'

@Injectable()
export class CashbackCron {
  private readonly logger = new Logger(CashbackCron.name)

  constructor(private readonly cashback: CashbackService) {}

  /** Roda 03:00 BRT (06:00 UTC) — expira earns antigos.
   *  Idempotente — UNIQUE (org, source_kind, source_id, type) previne
   *  re-expiração se rodar 2 vezes. */
  @Cron('0 6 * * *')  // 06:00 UTC = 03:00 BRT
  async dailyExpire() {
    try {
      const result = await this.cashback.expireOldEarns()
      if (result.expiredCount > 0) {
        this.logger.log(`[cashback.cron] expirou ${result.expiredCount} earns, total ${result.expiredCents}c`)
      }
    } catch (err) {
      this.logger.error(`[cashback.cron] expire falhou: ${(err as Error).message}`)
    }
  }

  /** Roda 04:00 BRT (07:00 UTC) — credita cashbacks com earnDelay
   *  ='after_7_days' pra pedidos paid 7+ dias atrás. Idempotente
   *  via UNIQUE no source_id da movements. */
  @Cron('0 7 * * *')  // 07:00 UTC = 04:00 BRT
  async dailyDelayedCredit() {
    try {
      const result = await this.cashback.creditDelayedEarns()
      if (result.credited > 0) {
        this.logger.log(`[cashback.cron] delayed credit: ${result.credited} novos earns (${result.orgsScanned} orgs)`)
      }
    } catch (err) {
      this.logger.error(`[cashback.cron] delayed credit falhou: ${(err as Error).message}`)
    }
  }
}
