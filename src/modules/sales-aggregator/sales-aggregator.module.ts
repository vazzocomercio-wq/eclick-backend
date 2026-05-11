import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MessagingModule } from '../messaging/messaging.module'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'
import { MercadoLivreClient } from './clients/mercado-livre-client'
import { OrdersIngestionService } from './services/orders-ingestion.service'
import { SnapshotsAggregationService } from './services/snapshots-aggregation.service'
import { BackfillService } from './services/backfill.service'
import { NewSaleNotifierService } from './services/new-sale-notifier.service'
import { SalesAggregatorController } from './sales-aggregator.controller'

@Module({
  imports: [
    MercadolivreModule,
    MessagingModule,        // auto-trigger pós-upsert
    IntelligenceHubModule,  // alert_signals emit pra toast de venda nova
  ],
  controllers: [SalesAggregatorController],
  providers:   [MercadoLivreClient, OrdersIngestionService, SnapshotsAggregationService, BackfillService, NewSaleNotifierService],
  exports:     [BackfillService, OrdersIngestionService],
})
export class SalesAggregatorModule {}
