import { Module } from '@nestjs/common'
import { EnrichmentService } from './enrichment.service'
import { EnrichmentController } from './enrichment.controller'
import { EnrichmentCacheService } from './services/cache.service'
import { EnrichmentRoutingService } from './services/routing.service'
import { EnrichmentConsentService } from './services/consent.service'
import { EnrichmentAuditService } from './services/audit.service'
import { EnrichmentCostTrackerService } from './services/cost-tracker.service'
import { WhatsAppValidationService } from './services/whatsapp-validation.service'
import { ALL_PROVIDERS, enrichmentRegistryProvider, ENRICHMENT_PROVIDERS } from './providers'

@Module({
  controllers: [EnrichmentController],
  providers: [
    EnrichmentService,
    EnrichmentCacheService,
    EnrichmentRoutingService,
    EnrichmentConsentService,
    EnrichmentAuditService,
    EnrichmentCostTrackerService,
    WhatsAppValidationService,
    ...ALL_PROVIDERS,
    enrichmentRegistryProvider,
  ],
  exports: [
    EnrichmentService,
    EnrichmentCacheService,
    EnrichmentRoutingService,
    EnrichmentConsentService,
    EnrichmentAuditService,
    EnrichmentCostTrackerService,
    WhatsAppValidationService,
    ENRICHMENT_PROVIDERS,
  ],
})
export class EnrichmentModule {}
