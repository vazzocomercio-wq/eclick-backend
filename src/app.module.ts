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
import { MarketplaceChannelsModule } from './modules/marketplace-channels/marketplace-channels.module'
import { ChannelsModule } from './modules/channels/channels.module'
import { WaRouterModule } from './modules/wa-router/wa-router.module'
import { InternalModule } from './modules/internal/internal.module'
import { EventsModule } from './modules/events/events.module'
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
import { HealthModule } from './modules/health/health.module'
import { CampaignsModule } from './modules/campaigns/campaigns.module'
import { AiModule } from './modules/ai/ai.module'
import { MarketplaceScrapingModule } from './modules/marketplace-scraping/marketplace-scraping.module'
import { CanvaOauthModule } from './modules/canva-oauth/canva-oauth.module'
import { CanvaModule } from './modules/canva/canva.module'
import { IntelligenceHubModule } from './modules/intelligence-hub/intelligence-hub.module'
import { CreativeModule } from './modules/creative/creative.module'
import { CopilotModule } from './modules/copilot/copilot.module'
import { SocialContentModule } from './modules/social-content/social-content.module'

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
    MarketplaceChannelsModule,
    ChannelsModule,
    WaRouterModule,
    InternalModule,
    EventsModule,
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
    HealthModule,
    CampaignsModule,
    AiModule,
    MarketplaceScrapingModule,
    CanvaOauthModule,
    CanvaModule,
    IntelligenceHubModule,
    CreativeModule,
    CopilotModule,
    SocialContentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
