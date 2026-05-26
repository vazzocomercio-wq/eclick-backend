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

  /** Domingo 05:00 BRT (08:00 UTC) — reconciliação FIFO: confere se
   *  Σ remaining(lotes ativos) == balance_cents por cliente. Só reporta no log
   *  (não corrige; rodar o backfill resolve). Backstop contra drift de race. */
  @Cron('0 8 * * 0')  // domingo 08:00 UTC = 05:00 BRT
  async weeklyReconcile() {
    try {
      const result = await this.cashback.reconcileLots()
      if (result.mismatches.length > 0) {
        const sample = result.mismatches.slice(0, 10)
          .map(m => `${m.customer}(saldo=${m.balance}c lotes=${m.lotsSum}c)`).join(', ')
        this.logger.warn(`[cashback.cron] reconcile: ${result.mismatches.length}/${result.checked} divergências. Amostra: ${sample}`)
      } else {
        this.logger.log(`[cashback.cron] reconcile OK: ${result.checked} clientes, 0 divergências`)
      }
    } catch (err) {
      this.logger.error(`[cashback.cron] reconcile falhou: ${(err as Error).message}`)
    }
  }
}
