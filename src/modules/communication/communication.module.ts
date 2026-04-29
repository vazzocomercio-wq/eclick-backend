import { Module } from '@nestjs/common'
import { EnrichmentModule } from '../enrichment/enrichment.module'
import { MessagingModule } from '../messaging/messaging.module'
import { AdminCommunicationController } from './controllers/admin-communication.controller'
import { CommunicationCenterController } from './controllers/communication-center.controller'
import { CustomerResolverService } from './services/customer-resolver.service'
import { JourneyProcessorService } from './services/journey-processor.service'
import { OrderStatusWatcherService } from './services/order-status-watcher.service'
import { CommunicationCenterService } from './services/communication-center.service'

/** Sprint COM1
 * - CC-1 JourneyProcessorService: processa order_communication_journeys
 *   pending, resolve customer, enriquece, cria messaging_journey_run com
 *   step 0 imediato (cron @30s).
 * - CC-2 (em messaging/journey-engine.service.ts): renderiza+envia, avança
 *   step (cron @5min).
 * - CC-3 OrderStatusWatcherService: detecta orders.shipping_status que bate
 *   com step.condition de runs paused (next_step_at=null) e desbloqueia
 *   (cron @5min).
 *
 * Sprint 3.1 — CommunicationCenterService/Controller: endpoints REST sob
 * /communication pra dashboard + journeys + templates (soft delete) +
 * settings. Importa MessagingModule pra reusar MessagingService.
 *
 * AdminSecretGuard é instanciado direto pelo NestJS (zero deps DI). */
@Module({
  imports:     [EnrichmentModule, MessagingModule],
  controllers: [AdminCommunicationController, CommunicationCenterController],
  providers:   [
    CustomerResolverService,
    JourneyProcessorService,
    OrderStatusWatcherService,
    CommunicationCenterService,
  ],
  exports:     [
    JourneyProcessorService,
    CustomerResolverService,
    OrderStatusWatcherService,
    CommunicationCenterService,
  ],
})
export class CommunicationModule {}
