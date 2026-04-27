import { Module } from '@nestjs/common'
import { EnrichmentCacheService } from './services/cache.service'
import { EnrichmentRoutingService } from './services/routing.service'
import { EnrichmentConsentService } from './services/consent.service'
import { EnrichmentAuditService } from './services/audit.service'
import { EnrichmentCostTrackerService } from './services/cost-tracker.service'
import { ALL_PROVIDERS, enrichmentRegistryProvider, ENRICHMENT_PROVIDERS } from './providers'

@Module({
  providers: [
    EnrichmentCacheService,
    EnrichmentRoutingService,
    EnrichmentConsentService,
    EnrichmentAuditService,
    EnrichmentCostTrackerService,
    ...ALL_PROVIDERS,
    enrichmentRegistryProvider,
  ],
  exports: [
    EnrichmentCacheService,
    EnrichmentRoutingService,
    EnrichmentConsentService,
    EnrichmentAuditService,
    EnrichmentCostTrackerService,
    ENRICHMENT_PROVIDERS,
  ],
})
export class EnrichmentModule {}
