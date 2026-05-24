import { Module } from '@nestjs/common'
import { FulfillmentController } from './fulfillment.controller'
import { FulfillmentService } from './fulfillment.service'
import { FulfillmentAiService } from './fulfillment-ai.service'
import { FulfillmentLabelsService } from './fulfillment-labels.service'
import { FulfillmentReconcileService } from './fulfillment-reconcile.service'
import { FulfillmentReturnsService } from './fulfillment-returns.service'
import { FulfillmentWaveService } from './fulfillment-wave.service'
import { FulfillmentAccountsService } from './fulfillment-accounts.service'
import { FulfillmentInvoicesService } from './fulfillment-invoices.service'
import { AiModule } from '../ai/ai.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { StockModule } from '../stock/stock.module'

@Module({
  imports:     [AiModule, MercadolivreModule, StockModule],
  controllers: [FulfillmentController],
  providers:   [FulfillmentService, FulfillmentAiService, FulfillmentLabelsService, FulfillmentReconcileService, FulfillmentReturnsService, FulfillmentWaveService, FulfillmentAccountsService, FulfillmentInvoicesService],
  exports:     [FulfillmentService],
})
export class FulfillmentModule {}
