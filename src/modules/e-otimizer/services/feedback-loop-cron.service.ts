/**
 * e-Otimizer IA MVP 5 — cron diário de captura de métricas pós-otimização.
 *
 * Roda 1× por dia às 03:17 BRT (horário de baixa carga). Pega até 50
 * otimizações com `applied_at IS NOT NULL` e `metrics_t30d IS NULL`,
 * captura checkpoints `t7d/t14d/t30d` conforme idade desde aplicar.
 *
 * Pra desligar manualmente em prod: env `DISABLE_E_OTIMIZER_FEEDBACK_CRON=true`.
 */

import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { FeedbackLoopService } from './feedback-loop.service'

@Injectable()
export class FeedbackLoopCronService {
  private readonly logger = new Logger(FeedbackLoopCronService.name)

  constructor(private readonly feedback: FeedbackLoopService) {}

  /**
   * Cron diário às 03:17 BRT. Horário deliberado pra evitar conflito com
   * outros crons (que costumam rodar :00, :17, :30) e cair em janela de
   * baixa carga do ML API.
   */
  @Cron('17 3 * * *', { name: 'e-otimizer-feedback-loop', timeZone: 'America/Sao_Paulo' })
  async run(): Promise<void> {
    if (process.env.DISABLE_E_OTIMIZER_FEEDBACK_CRON === 'true') {
      this.logger.warn('feedback loop DESLIGADO (DISABLE_E_OTIMIZER_FEEDBACK_CRON=true)')
      return
    }

    this.logger.log('[feedback-cron] iniciando captura de métricas…')
    const t0 = Date.now()
    try {
      const result = await this.feedback.captureBatch(50)
      const dt = ((Date.now() - t0) / 1000).toFixed(1)
      this.logger.log(
        `[feedback-cron] OK em ${dt}s — processed=${result.processed} ` +
        `captured=${result.captured} errors=${result.errors}`,
      )
    } catch (e: unknown) {
      this.logger.error(`[feedback-cron] FALHOU: ${(e as Error).message}`)
    }
  }
}
