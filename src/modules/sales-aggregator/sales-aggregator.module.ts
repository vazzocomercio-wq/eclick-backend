import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MercadoLivreClient } from './clients/mercado-livre-client'
import { OrdersIngestionService } from './services/orders-ingestion.service'
import { SnapshotsAggregationService } from './services/snapshots-aggregation.service'
import { BackfillService } from './services/backfill.service'
import { SalesAggregatorController } from './sales-aggregator.controller'

@Module({
  imports:     [MercadolivreModule],
  controllers: [SalesAggregatorController],
  providers:   [MercadoLivreClient, OrdersIngestionService, SnapshotsAggregationService, BackfillService],
  exports:     [BackfillService, OrdersIngestionService],
})
export class SalesAggregatorModule {}
