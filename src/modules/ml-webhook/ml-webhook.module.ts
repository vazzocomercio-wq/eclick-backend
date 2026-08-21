import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlPostsaleModule } from '../ml-postsale/ml-postsale.module'
import { MlVerticalModule } from '../ml-vertical/ml-vertical.module'
import { SalesAggregatorModule } from '../sales-aggregator/sales-aggregator.module'
import { MlReputationModule } from '../ml-reputation/ml-reputation.module'
import { MlWebhookController } from './ml-webhook.controller'
import { MlWebhookDispatcherService } from './ml-webhook-dispatcher.service'

/**
 * Receptor público de notificações do Mercado Livre.
 * URL: POST /ml/webhook
 *
 * Despacha por topic:
 *   - messages  → MlPostsaleService
 *   - questions → MlQuestionsAiService (pré-venda, refator MVP 1)
 *   - claims / orders_v2 / shipments → também agendam recálculo da reputação
 *     local da conta (MlReputationService.scheduleRecalc, debounce 20s)
 *   - outros    → log e ignora
 */
@Module({
  imports:     [MercadolivreModule, MlPostsaleModule, MlVerticalModule, SalesAggregatorModule, MlReputationModule],
  controllers: [MlWebhookController],
  providers:   [MlWebhookDispatcherService],
})
export class MlWebhookModule {}
