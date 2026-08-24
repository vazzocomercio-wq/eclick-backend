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
import { FulfillmentPackagingService } from './fulfillment-packaging.service'
import { FulfillmentFiscalService } from './fulfillment-fiscal.service'
import { FulfillmentSefazService } from './fulfillment-sefaz.service'
import { FulfillmentDanfeService } from './fulfillment-danfe.service'
import { FulfillmentLocationsService } from './fulfillment-locations.service'
import { FulfillmentCartsService } from './fulfillment-carts.service'
import { AiModule } from '../ai/ai.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { StockModule } from '../stock/stock.module'
import { CredentialsModule } from '../credentials/credentials.module'
import { CompositionModule } from '../composition/composition.module'
import { MarketplaceModule } from '../marketplace/marketplace.module'

@Module({
  // Composition + Marketplace: F2b-3 (emissão de NF-e explode kits e re-ingere o pedido Shopee ao vivo)
  imports:     [AiModule, MercadolivreModule, StockModule, CredentialsModule, CompositionModule, MarketplaceModule],
  controllers: [FulfillmentController],
  providers:   [FulfillmentService, FulfillmentAiService, FulfillmentLabelsService, FulfillmentReconcileService, FulfillmentReturnsService, FulfillmentWaveService, FulfillmentAccountsService, FulfillmentInvoicesService, FulfillmentPackagingService, FulfillmentFiscalService, FulfillmentSefazService, FulfillmentDanfeService, FulfillmentLocationsService, FulfillmentCartsService],
  exports:     [FulfillmentService],
})
export class FulfillmentModule {}
