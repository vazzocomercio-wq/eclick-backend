import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { MercadolivreModule } from './modules/mercadolivre/mercadolivre.module'
import { OrdersModule } from './modules/orders/orders.module'
import { ProductsModule } from './modules/products/products.module'
import { SalesAggregatorModule } from './modules/sales-aggregator/sales-aggregator.module'
import { SuppliersModule } from './modules/suppliers/suppliers.module'
import { ComprasModule } from './modules/compras/compras.module'
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module'
import { CompetitorsModule } from './modules/competitors/competitors.module'
import { AtendenteIaModule } from './modules/atendente-ia/atendente-ia.module'
import { CredentialsModule } from './modules/credentials/credentials.module'
import { AiUsageModule } from './modules/ai-usage/ai-usage.module'
import { StockModule } from './modules/stock/stock.module'
import { ChannelsModule } from './modules/channels/channels.module'
import { CustomersModule } from './modules/customers/customers.module'
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module'
import { WebhooksModule } from './modules/webhooks/webhooks.module'
import { WidgetsModule } from './modules/widgets/widgets.module'
import { MlAdsModule } from './modules/ml-ads/ml-ads.module'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MercadolivreModule,
    OrdersModule,
    ProductsModule,
    SalesAggregatorModule,
    SuppliersModule,
    ComprasModule,
    PurchaseOrdersModule,
    CompetitorsModule,
    AtendenteIaModule,
    CredentialsModule,
    AiUsageModule,
    StockModule,
    ChannelsModule,
    CustomersModule,
    WhatsAppModule,
    WidgetsModule,
    WebhooksModule,
    MlAdsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
