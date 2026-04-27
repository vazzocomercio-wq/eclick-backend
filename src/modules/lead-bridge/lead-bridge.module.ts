import { Module } from '@nestjs/common'
import { LeadBridgeController } from './lead-bridge.controller'
import { LeadBridgePublicController } from './lead-bridge-public.controller'
import { LeadBridgeService } from './lead-bridge.service'
import { LinkGeneratorService } from './services/link-generator.service'
import { CpfEnrichmentService } from './services/cpf-enrichment.service'
import { WhatsAppTriggerService } from './services/whatsapp-trigger.service'
import { JourneyEngineService } from './services/journey-engine.service'
import { CustomersModule } from '../customers/customers.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'

@Module({
  imports:     [CustomersModule, WhatsAppModule],
  controllers: [LeadBridgeController, LeadBridgePublicController],
  providers:   [
    LeadBridgeService,
    LinkGeneratorService,
    CpfEnrichmentService,
    WhatsAppTriggerService,
    JourneyEngineService,
  ],
  exports:     [LeadBridgeService],
})
export class LeadBridgeModule {}
