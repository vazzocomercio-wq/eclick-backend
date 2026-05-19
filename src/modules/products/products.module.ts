import { Module } from '@nestjs/common'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'
import { ProductsEnrichmentService } from './products-enrichment.service'
import { ProductsEnrichmentWorker } from './products-enrichment.worker'
import { ProductsEnrichmentBatchWorker } from './products-enrichment-batch.worker'
import { ProductsImportService } from './products-import.service'
import { ProductsCompletenessService } from './products-completeness.service'
import { ProductsListingCoverageService } from './products-listing-coverage.service'
import { MlCategoryRequirementsService } from './ml-category-requirements.service'
import { ProductsCadastroDispatchService } from './products-cadastro-dispatch.service'
import { StockModule } from '../stock/stock.module'
import { CreativeModule } from '../creative/creative.module'
import { AiModule } from '../ai/ai.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

@Module({
  imports:     [StockModule, CreativeModule, AiModule, MercadolivreModule, ActiveBridgeModule],
  controllers: [ProductsController],
  providers:   [
    ProductsService,
    ProductsEnrichmentService,
    ProductsEnrichmentWorker,
    ProductsEnrichmentBatchWorker,
    ProductsImportService,
    ProductsCompletenessService,
    ProductsListingCoverageService,
    MlCategoryRequirementsService,
    ProductsCadastroDispatchService,
  ],
  exports:     [
    ProductsService,
    ProductsEnrichmentService,
    ProductsImportService,
    ProductsCompletenessService,
    MlCategoryRequirementsService,
    ProductsCadastroDispatchService,
  ],
})
export class ProductsModule {}
