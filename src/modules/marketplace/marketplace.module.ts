import { Module, forwardRef } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { StockModule } from '../stock/stock.module'
import { MercadoLivreAdapter } from './adapters/ml.adapter'
import { MagaluAdapter } from './adapters/magalu.adapter'
import { ShopeeAdapter } from './adapters/shopee.adapter'
import { MarketplaceAdapterRegistry } from './adapters/registry'
import { MarketplaceService } from './marketplace.service'
import { MarketplaceController } from './marketplace.controller'
import { MarketplaceWebhooksController } from './marketplace-webhooks.controller'
import { MarketplaceWebhooksService } from './marketplace-webhooks.service'
import { ShopThrottleService } from './throttle/shop-throttle.service'
import { ShopeeAlgoScoreService } from './shopee-algo-score/shopee-algo-score.service'
import { ShopeeListingsController } from './shopee-algo-score/shopee-listings.controller'
import { ShopeeListingsService } from './shopee-algo-score/shopee-listings.service'
import { ShopeeQualityController } from './shopee-quality/shopee-quality.controller'
import { ShopeeQualityService } from './shopee-quality/shopee-quality.service'
import { ShopeeCampaignsController } from './shopee-campaigns/shopee-campaigns.controller'
import { ShopeeCampaignsService } from './shopee-campaigns/shopee-campaigns.service'
import { CampaignMarginService } from './shopee-campaigns/campaign-margin.service'
import { ShopeeMarketingService } from './shopee-campaigns/shopee-marketing.service'
import { ShopeeMarketingController } from './shopee-campaigns/shopee-marketing.controller'
import { ShopeeRadarController } from './shopee-radar/shopee-radar.controller'
import { ShopeeRadarService } from './shopee-radar/shopee-radar.service'
import { ShopeeCreativeController } from './shopee-creative/shopee-creative.controller'
import { ShopeeCreativePublisherService } from './shopee-creative/shopee-creative.service'
import { ShopeeSyncController } from './shopee-sync/shopee-sync.controller'
import { ShopeeProductSyncService } from './shopee-sync/shopee-product-sync.service'
import { ShopeeShopMetricsSyncService } from './shopee-sync/shopee-metrics-sync.service'
import { ShopeeCampaignsSyncService } from './shopee-sync/shopee-campaigns-sync.service'
import { ShopeeOrdersIngestionService } from './shopee-sync/shopee-orders-ingestion.service'
import { ShopeeEscrowIngestService } from './shopee-sync/shopee-escrow-ingest.service'
import { ShopeeListingLinkService } from './shopee-sync/shopee-listing-link.service'
import { ShopeeListingLinkController } from './shopee-sync/shopee-listing-link.controller'
import { ShopeeStockSyncService } from './shopee-sync/shopee-stock-sync.service'
import { ShopeeReturnsSyncService } from './shopee-sync/shopee-returns-sync.service'
import { ShopeeTokenRefreshWorker } from './shopee-sync/shopee-token-refresh.worker'
import { ShopeeReturnsPlaybookService } from './shopee-returns-playbook/shopee-returns-playbook.service'
import { ShopeeReturnsPlaybookController } from './shopee-returns-playbook/shopee-returns-playbook.controller'
import { ShopeeChatService } from './shopee-chat/shopee-chat.service'
import { ShopeeChatController } from './shopee-chat/shopee-chat.controller'
import { ShopeeReviewsService } from './shopee-reviews/shopee-reviews.service'
import { ShopeeReviewsController } from './shopee-reviews/shopee-reviews.controller'
import { ReviewCentralService } from './review-central/review-central.service'
import { ReviewCentralController } from './review-central/review-central.controller'
import { MlReviewsSyncService } from './review-central/ml-reviews-sync.service'
import { ReturnsSacBridgeService } from './returns-sac/returns-sac.service'
import { ReturnsSacController } from './returns-sac/returns-sac.controller'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { WaRouterModule } from '../wa-router/wa-router.module'
import { ChannelSettingsModule } from '../channel-settings/channel-settings.module'
import { AiModule } from '../ai/ai.module'

@Module({
  // forwardRef(StockModule): venda Shopee → baixa estoque mestre (ingestão de
  // pedidos) precisa do StockService, e StockModule já importa este módulo
  // (ShopeeStockSyncService no recalcAndPropagate).
  imports:     [MercadolivreModule, ChannelSettingsModule, AiModule, ActiveBridgeModule, WaRouterModule, forwardRef(() => StockModule)], // ML billing + comissão canal + IA + ponte Active/WA (Central de Avaliações)
  controllers: [
    MarketplaceController, MarketplaceWebhooksController,
    ShopeeListingsController,  // F1.2 — GET /shopee/listings/scores
    ShopeeQualityController,   // F1.3 — GET /shopee/shop-metrics/{latest,history}
    ShopeeCampaignsController, // F1.4 — GET /shopee/campaigns + /shopee/campaigns/:id
    ShopeeRadarController,     // F1.5 — GET /shopee/radar/signals + /shopee/radar/by-type
    ShopeeCreativeController,  // F1.7 — POST /shopee/creative/evaluate (guard)
    ShopeeSyncController,       // F0.7 — POST /shopee/sync/products (sync real)
    ShopeeListingLinkController, // F18 Fase A — vínculo anúncio↔produto (auto/manual + status)
    ShopeeMarketingController,   // F18 Marketing inteligente — recomendações + probe escopo
    ShopeeReturnsPlaybookController, // Playbook IA de devoluções — recomendação + ações (accept/dispute)
    ShopeeChatController,        // Pós-venda B — chat sellerchat (dormante até permissão do app)
    ShopeeReviewsController,     // Central de Avaliações — reviews + resposta IA
    ReviewCentralController,     // Central de Avaliações — config automação + sync ML
    ReturnsSacController,        // SAC — devolução → card no funil do Active + Vincular SAC do pedido
  ],
  providers:   [
    MercadoLivreAdapter, MagaluAdapter, ShopeeAdapter,
    MarketplaceAdapterRegistry, MarketplaceService,
    MarketplaceWebhooksService,
    ShopThrottleService,             // F0.6 — throttle por shop_id pra ShopeeAdapter
    ShopeeAlgoScoreService,          // F1.1 — Algorithm Score 4 pilares
    ShopeeListingsService,           // F1.2 — query da view v_latest_algo_score
    ShopeeQualityService,            // F1.3 — Quality Center (snapshot + alerts)
    ShopeeCampaignsService,          // F1.4 — Campaign Center (READ-ONLY Sprint 1)
    CampaignMarginService,           // F3.1 — gate de margem pós-comissão
    ShopeeMarketingService,          // F18 Marketing inteligente — motor de recomendação
    ShopeeRadarService,              // F1.5 — Radar de mercado Shopee
    ShopeeCreativePublisherService,  // F1.7 — guard de pré-publicação
    ShopeeProductSyncService,        // F0.7 — sync de produtos reais → algo score
    ShopeeShopMetricsSyncService,    // F1.3 — sync de métricas da loja (account_health)
    ShopeeCampaignsSyncService,      // F1.4 — sync de campanhas (voucher + flash_sale)
    ShopeeOrdersIngestionService,    // F1.6 — ingestão de pedidos Shopee na CENTRAL
    ShopeeEscrowIngestService,       // Fase 2.3 — escrow real → platform_charges
    ShopeeListingLinkService,        // F18 Fase A — vínculo anúncio↔produto (keystone)
    ShopeeStockSyncService,          // F18 Fase C — propaga estoque do ledger → anúncio Shopee
    ShopeeReturnsSyncService,        // Pós-venda Fase C — devoluções (returns API) → mediações
    ShopeeReturnsPlaybookService,    // Playbook IA de devoluções — motor regras+IA, copiloto e auto opt-in (gate RETURN_PLAYBOOK)
    ShopeeChatService,               // Pós-venda Fase B — chat sellerchat (gate SHOPEE_CHAT_SYNC)
    ShopeeReviewsService,            // Central de Avaliações (gate SHOPEE_REVIEW_SYNC)
    ReviewCentralService,            // Automação: positiva auto-responde, negativa → WA + funil Active (gate REVIEW_AUTOPILOT)
    MlReviewsSyncService,            // Avaliações do ML (gate ML_REVIEW_SYNC; sem resposta pública)
    ReturnsSacBridgeService,         // SAC — devoluções → funil Active (gate RETURNS_SAC_SYNC)
    ShopeeTokenRefreshWorker,        // F0.2 — refresh proativo de token (@Cron 1h)
  ],
  exports:     [
    MarketplaceService, MarketplaceAdapterRegistry,
    ShopeeAlgoScoreService,    // F1.1 — exporta pra outros módulos (Listing Center)
    ShopeeQualityService,      // F1.3 — exporta pro Algorithm Score Pillar 3 reusar
    ShopeeStockSyncService,    // F18 Fase C — StockService chama no recalcAndPropagate
    ShopeeCreativePublisherService, // sync de confirmação — CreativeModule injeta
  ],
})
export class MarketplaceModule {}
