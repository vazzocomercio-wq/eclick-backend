import { Module } from '@nestjs/common'
import { EnrichmentCacheService } from './services/cache.service'
import { EnrichmentRoutingService } from './services/routing.service'
import { EnrichmentConsentService } from './services/consent.service'
import { EnrichmentAuditService } from './services/audit.service'
import { EnrichmentCostTrackerService } from './services/cost-tracker.service'

@Module({
  providers: [
    EnrichmentCacheService,
    EnrichmentRoutingService,
    EnrichmentConsentService,
    EnrichmentAuditService,
    EnrichmentCostTrackerService,
  ],
  exports: [
    EnrichmentCacheService,
    EnrichmentRoutingService,
    EnrichmentConsentService,
    EnrichmentAuditService,
    EnrichmentCostTrackerService,
  ],
})
export class EnrichmentModule {}
