import { Module } from '@nestjs/common'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'
import { ProductsEnrichmentService } from './products-enrichment.service'
import { ProductsEnrichmentWorker } from './products-enrichment.worker'
import { ProductsEnrichmentBatchWorker } from './products-enrichment-batch.worker'
import { StockModule } from '../stock/stock.module'
import { CreativeModule } from '../creative/creative.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [StockModule, CreativeModule, AiModule],
  controllers: [ProductsController],
  providers:   [
    ProductsService,
    ProductsEnrichmentService,
    ProductsEnrichmentWorker,
    ProductsEnrichmentBatchWorker,
  ],
  exports:     [ProductsService, ProductsEnrichmentService],
})
export class ProductsModule {}
