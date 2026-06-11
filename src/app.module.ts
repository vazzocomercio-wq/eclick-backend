import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { MercadolivreModule } from './modules/mercadolivre/mercadolivre.module'
import { MlQualityModule } from './modules/ml-quality/ml-quality.module'
import { OrdersModule } from './modules/orders/orders.module'
import { ProductsModule } from './modules/products/products.module'
import { SalesAggregatorModule } from './modules/sales-aggregator/sales-aggregator.module'
import { SuppliersModule } from './modules/suppliers/suppliers.module'
import { ComprasModule } from './modules/compras/compras.module'
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module'
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
import { ShopeeAffiliateModule } from './modules/shopee-affiliate/shopee-affiliate.module'
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
import { SocialCommerceModule } from './modules/social-commerce/social-commerce.module'
import { AdsCampaignsModule } from './modules/ads-campaigns/ads-campaigns.module'
import { ProductsAnalyticsModule } from './modules/products-analytics/products-analytics.module'
import { PricingAiModule } from './modules/pricing-ai/pricing-ai.module'
import { StoreAutomationModule } from './modules/store-automation/store-automation.module'
import { KitsModule } from './modules/kits/kits.module'
import { CategoryLinksModule } from './modules/category-links/category-links.module'
import { StorefrontModule } from './modules/storefront/storefront.module'
import { StoreCopilotModule } from './modules/store-copilot/store-copilot.module'
import { StoreConfigModule } from './modules/store-config/store-config.module'
import { CouponsModule } from './modules/coupons/coupons.module'
import { ShippingModule } from './modules/shipping/shipping.module'
import { CashbackModule } from './modules/cashback/cashback.module'
import { BonusModule } from './modules/bonus/bonus.module'
import { PromotionCampaignsModule } from './modules/promotion-campaigns/promotion-campaigns.module'
import { AffiliatesModule } from './modules/affiliates/affiliates.module'
import { LoyaltyModule } from './modules/loyalty/loyalty.module'
import { StorefrontCustomersModule } from './modules/storefront-customers/storefront-customers.module'
import { ProductReviewsModule } from './modules/product-reviews/product-reviews.module'
import { CartRecoveryModule } from './modules/cart-recovery/cart-recovery.module'
import { StorefrontLeadsModule } from './modules/storefront-leads/storefront-leads.module'
import { StorefrontVisualizerModule } from './modules/storefront-visualizer/storefront-visualizer.module'
import { StorefrontAnalyticsModule } from './modules/storefront-analytics/storefront-analytics.module'
import { StorefrontNotificationsModule } from './modules/storefront-notifications/storefront-notifications.module'
import { StorefrontEventsModule } from './modules/storefront-events/storefront-events.module'
import { StorefrontVariantsModule } from './modules/storefront-variants/storefront-variants.module'
import { ProductTelemetryModule } from './modules/product-telemetry/product-telemetry.module'
import { BannerGeneratorModule } from './modules/banner-generator/banner-generator.module'
import { StoreBlogModule } from './modules/store-blog/store-blog.module'
import { BlogNewsletterModule } from './modules/blog-newsletter/blog-newsletter.module'
import { FulfillmentModule } from './modules/fulfillment/fulfillment.module'
import { PaymentsModule } from './modules/payments/payments.module'
import { MlAiCoreModule } from './modules/ml-ai-core/ml-ai-core.module'
import { MlCampaignsModule } from './modules/ml-campaigns/ml-campaigns.module'
import { MlPostsaleModule } from './modules/ml-postsale/ml-postsale.module'
import { MlWebhookModule } from './modules/ml-webhook/ml-webhook.module'
import { MlVerticalModule } from './modules/ml-vertical/ml-vertical.module'
import { DropshipModule } from './modules/dropship/dropship.module'
import { FinanceiroModule } from './modules/financeiro/financeiro.module'
import { MlListingModule } from './modules/ml-listing/ml-listing.module'
import { ExecutiveDashboardModule } from './modules/executive-dashboard/executive-dashboard.module'
import { VisitsScannerModule } from './modules/ml-intelligence/visits-scanner/visits-scanner.module'
import { EOtimizerModule } from './modules/e-otimizer/e-otimizer.module'
import { IcarusIntegrationModule } from './modules/icarus-integration/icarus-integration.module'
import { RadarModule } from './modules/radar/radar.module'
import { AiVisibilityModule } from './modules/ai-visibility/ai-visibility.module'
import { PublicAuditsModule } from './modules/public-audits/public-audits.module'
import { AnalyticsHubModule } from './modules/analytics-hub/analytics-hub.module'
import { TikTokShopModule } from './modules/tiktok-shop/tiktok-shop.module'
import { ChannelSettingsModule } from './modules/channel-settings/channel-settings.module'
import { AccessModule } from './modules/access/access.module'
import { MultiplierModule } from './modules/multiplier/multiplier.module'
import { RbacModule } from './modules/rbac/rbac.module'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RbacModule,
    MercadolivreModule,
    MlQualityModule,
    OrdersModule,
    ProductsModule,
    SalesAggregatorModule,
    SuppliersModule,
    ComprasModule,
    PurchaseOrdersModule,
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
    ShopeeAffiliateModule,
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
    SocialCommerceModule,
    AdsCampaignsModule,
    ProductsAnalyticsModule,
    PricingAiModule,
    StoreAutomationModule,
    KitsModule,
    CategoryLinksModule,
    StorefrontModule,
    StoreCopilotModule,
    StoreConfigModule,
    CouponsModule,
    ShippingModule,
    CashbackModule,
    BonusModule,
    PromotionCampaignsModule,
    AffiliatesModule,
    LoyaltyModule,
    StorefrontCustomersModule,
    ProductReviewsModule,
    CartRecoveryModule,
    StorefrontLeadsModule,
    StorefrontVisualizerModule,
    StorefrontAnalyticsModule,
    StorefrontNotificationsModule,
    StorefrontEventsModule,
    StorefrontVariantsModule,
    ProductTelemetryModule,
    BannerGeneratorModule,
    StoreBlogModule,
    BlogNewsletterModule,
    FulfillmentModule,
    PaymentsModule,
    MlAiCoreModule,
    MlCampaignsModule,
    MlVerticalModule,
    MlPostsaleModule,
    MlWebhookModule,
    DropshipModule,
    FinanceiroModule,
    MlListingModule,
    ExecutiveDashboardModule,
    VisitsScannerModule,
    EOtimizerModule,
    IcarusIntegrationModule,
    RadarModule,
    AiVisibilityModule,
    PublicAuditsModule,
    AnalyticsHubModule,
    TikTokShopModule,
    ChannelSettingsModule,
    AccessModule,
    MultiplierModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
