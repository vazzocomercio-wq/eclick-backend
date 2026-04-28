import { Module } from '@nestjs/common'
import { EnrichmentModule } from '../enrichment/enrichment.module'
import { AdminCommunicationController } from './controllers/admin-communication.controller'
import { CustomerResolverService } from './services/customer-resolver.service'
import { JourneyProcessorService } from './services/journey-processor.service'
import { OrderStatusWatcherService } from './services/order-status-watcher.service'

/** Sprint COM1
 * - CC-1 JourneyProcessorService: processa order_communication_journeys
 *   pending, resolve customer, enriquece, cria messaging_journey_run com
 *   step 0 imediato (cron @30s).
 * - CC-2 (em messaging/journey-engine.service.ts): renderiza+envia, avança
 *   step (cron @5min).
 * - CC-3 OrderStatusWatcherService: detecta orders.shipping_status que bate
 *   com step.condition de runs paused (next_step_at=null) e desbloqueia
 *   (cron @5min).
 * AdminSecretGuard é instanciado direto pelo NestJS (zero deps DI). */
@Module({
  imports:     [EnrichmentModule],
  controllers: [AdminCommunicationController],
  providers:   [CustomerResolverService, JourneyProcessorService, OrderStatusWatcherService],
  exports:     [JourneyProcessorService, CustomerResolverService, OrderStatusWatcherService],
})
export class CommunicationModule {}
