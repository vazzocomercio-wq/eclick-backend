import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlAiCoreModule } from '../ml-ai-core/ml-ai-core.module'
import { EventsModule } from '../events/events.module'
import { MlPostsaleService } from './ml-postsale.service'
import { MlPostsaleController } from './ml-postsale.controller'
import { MlPostsaleSlaWorker } from './ml-postsale-sla.worker'

/**
 * Atendimento Pós-venda IA do Mercado Livre — MVP 1.
 *
 * Fluxo: webhook ML → MlWebhookDispatcher → MlPostsaleService.handleMessageWebhook
 *   → fetch ML pack/messages → persist → classify+suggest → SLA → Socket.IO
 *
 * Endpoints autenticados em /ml/postsale/*. Cron interno @5min recalcula
 * SLA das conversas pendentes.
 */
@Module({
  imports:     [MercadolivreModule, MlAiCoreModule, EventsModule],
  controllers: [MlPostsaleController],
  providers:   [MlPostsaleService, MlPostsaleSlaWorker],
  exports:     [MlPostsaleService],
})
export class MlPostsaleModule {}
