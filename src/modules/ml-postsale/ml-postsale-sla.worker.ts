import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { MlPostsaleService } from './ml-postsale.service'

/**
 * Worker interno (não polling de API externa) que recalcula SLA a cada 5min
 * pra todas as conversas com mensagem do comprador pendente. Este cron é
 * permitido pela política realtime-first (memory feedback_realtime_first.md):
 * é recálculo de estado sobre dados que JÁ temos no banco, não consulta a
 * API do ML.
 *
 * Quando o estado muda, o service emite Socket.IO `ml:postsale:sla_changed`.
 *
 * `DISABLE_ML_POSTSALE_SLA_WORKER=true` desliga em dev.
 */
@Injectable()
export class MlPostsaleSlaWorker {
  private readonly logger = new Logger(MlPostsaleSlaWorker.name)

  constructor(private readonly svc: MlPostsaleService) {}

  @Cron('*/5 * * * *', { name: 'ml-postsale-sla-recompute' })
  async tick(): Promise<void> {
    if (process.env.DISABLE_ML_POSTSALE_SLA_WORKER === 'true') return
    try {
      const { checked, transitions } = await this.svc.recomputeAllSlaStates()
      if (transitions > 0) {
        this.logger.log(`[ml-postsale-sla] checked=${checked} transitions=${transitions}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[ml-postsale-sla] tick falhou: ${msg}`)
    }
  }
}
