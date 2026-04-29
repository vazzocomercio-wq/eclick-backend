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
import { LeadBridgeModule } from './modules/lead-bridge/lead-bridge.module'
import { AdsAiModule } from './modules/ads-ai/ads-ai.module'
import { EnrichmentModule } from './modules/enrichment/enrichment.module'
import { UserPreferencesModule } from './modules/user-preferences/user-preferences.module'
import { AdminModule } from './modules/admin/admin.module'
import { MarketplaceModule } from './modules/marketplace/marketplace.module'
import { MessagingModule } from './modules/messaging/messaging.module'
import { EmailSettingsModule } from './modules/email-settings/email-settings.module'
import { CustomerHubModule } from './modules/customer-hub/customer-hub.module'
import { PricingIntelligenceModule } from './modules/pricing-intelligence/pricing-intelligence.module'
import { CommunicationModule } from './modules/communication/communication.module'
import { RoadmapModule } from './modules/roadmap/roadmap.module'

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
    LeadBridgeModule,
    AdsAiModule,
    EnrichmentModule,
    UserPreferencesModule,
    AdminModule,
    MarketplaceModule,
    MessagingModule,
    EmailSettingsModule,
    CustomerHubModule,
    PricingIntelligenceModule,
    CommunicationModule,
    RoadmapModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
