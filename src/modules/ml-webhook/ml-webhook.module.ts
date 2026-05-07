import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlPostsaleModule } from '../ml-postsale/ml-postsale.module'
import { MlVerticalModule } from '../ml-vertical/ml-vertical.module'
import { MlWebhookController } from './ml-webhook.controller'
import { MlWebhookDispatcherService } from './ml-webhook-dispatcher.service'

/**
 * Receptor público de notificações do Mercado Livre.
 * URL: POST /ml/webhook
 *
 * Despacha por topic:
 *   - messages  → MlPostsaleService
 *   - questions → MlQuestionsAiService (pré-venda, refator MVP 1)
 *   - outros    → log e ignora
 */
@Module({
  imports:     [MercadolivreModule, MlPostsaleModule, MlVerticalModule],
  controllers: [MlWebhookController],
  providers:   [MlWebhookDispatcherService],
})
export class MlWebhookModule {}
