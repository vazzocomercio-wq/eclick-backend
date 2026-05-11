import { Module } from '@nestjs/common'
import { MlListingController } from './ml-listing.controller'
import { MlListingService } from './services/ml-listing.service'
import { ListingAggregationService } from './services/listing-aggregation.service'
import { ListingStockScannerService } from './services/listing-stock-scanner.service'
import { ListingStatusScannerService } from './services/listing-status-scanner.service'
import { ListingPricingScannerService } from './services/listing-pricing-scanner.service'
import { ListingAutomationScannerService } from './services/listing-automation-scanner.service'
import { ListingCatalogScannerService } from './services/listing-catalog-scanner.service'
import { ListingFiscalScannerService } from './services/listing-fiscal-scanner.service'
import { ListingHealthScoreService } from './services/listing-health-score.service'
import { ListingBulkActionsService } from './services/listing-bulk-actions.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

/**
 * F10 ML Listing Center IA.
 * Sprint 1 (L1): aggregation + stock scanner + endpoints base.
 * Próximas sprints (L1-2 a L4) adicionarão status/pricing/automation/fiscal/score/copilot.
 */
@Module({
  imports: [MercadolivreModule],
  controllers: [MlListingController],
  providers: [
    MlListingService,
    ListingAggregationService,
    ListingStockScannerService,
    ListingStatusScannerService,
    ListingPricingScannerService,
    ListingAutomationScannerService,
    ListingCatalogScannerService,
    ListingFiscalScannerService,
    ListingHealthScoreService,
    ListingBulkActionsService,
  ],
  exports: [MlListingService, ListingAggregationService],
})
export class MlListingModule {}
