import { Module } from '@nestjs/common'
import { EnrichmentModule } from '../enrichment/enrichment.module'
import { AdminCommunicationController } from './controllers/admin-communication.controller'
import { CustomerResolverService } from './services/customer-resolver.service'
import { JourneyProcessorService } from './services/journey-processor.service'

/** Sprint COM1/CC-1 — worker que processa order_communication_journeys
 * com state='pending', resolve customer, opcionalmente enriquece, e
 * dispara step 1. CC-2 vai cuidar do envio real (WhatsApp/email) +
 * avanço de step. AdminSecretGuard é instanciado direto pelo NestJS
 * (zero deps de DI), não precisa importar AdminModule. */
@Module({
  imports:     [EnrichmentModule],
  controllers: [AdminCommunicationController],
  providers:   [CustomerResolverService, JourneyProcessorService],
  exports:     [JourneyProcessorService, CustomerResolverService],
})
export class CommunicationModule {}
