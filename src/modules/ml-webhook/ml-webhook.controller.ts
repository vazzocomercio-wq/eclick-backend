import { Controller, Post, Body, HttpCode, HttpStatus, Logger } from '@nestjs/common'
import { Public } from '../../common/decorators/public.decorator'
import { MlWebhookDispatcherService } from './ml-webhook-dispatcher.service'
import type { MlWebhookPayload } from './ml-webhook.types'

/**
 * Endpoint público de notificação do Mercado Livre.
 * Configurar no devcenter.mercadolivre.com.br > app > Notificações
 * URL: https://api.eclick.app.br/ml/webhook
 * Topics: messages, questions, orders_v2, claims
 *
 * IMPORTANTE: ML exige que retornemos 200 em <500ms, senão considera
 * falha e retenta. Por isso processamento é fire-and-forget.
 */
@Controller('ml/webhook')
export class MlWebhookController {
  private readonly logger = new Logger(MlWebhookController.name)

  constructor(private readonly dispatcher: MlWebhookDispatcherService) {}

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  receive(@Body() payload: MlWebhookPayload): { ok: true } {
    // Log compacto pra observabilidade — sem PII
    this.logger.log(`[ml-webhook] topic=${payload?.topic} seller=${payload?.user_id} resource=${payload?.resource}`)

    // Fire-and-forget: ML não retenta se chegou 200 ao receber
    void this.dispatcher.dispatch(payload).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`[ml-webhook] dispatch async falhou: ${msg}`)
    })

    return { ok: true }
  }
}
