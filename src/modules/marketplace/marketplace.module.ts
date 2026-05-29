import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
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
import { ShopeeRadarController } from './shopee-radar/shopee-radar.controller'
import { ShopeeRadarService } from './shopee-radar/shopee-radar.service'

@Module({
  imports:     [MercadolivreModule], // pra MlBillingFetcherService
  controllers: [
    MarketplaceController, MarketplaceWebhooksController,
    ShopeeListingsController,  // F1.2 — GET /shopee/listings/scores
    ShopeeQualityController,   // F1.3 — GET /shopee/shop-metrics/{latest,history}
    ShopeeCampaignsController, // F1.4 — GET /shopee/campaigns + /shopee/campaigns/:id
    ShopeeRadarController,     // F1.5 — GET /shopee/radar/signals + /shopee/radar/by-type
  ],
  providers:   [
    MercadoLivreAdapter, MagaluAdapter, ShopeeAdapter,
    MarketplaceAdapterRegistry, MarketplaceService,
    MarketplaceWebhooksService,
    ShopThrottleService,       // F0.6 — throttle por shop_id pra ShopeeAdapter
    ShopeeAlgoScoreService,    // F1.1 — Algorithm Score 4 pilares
    ShopeeListingsService,     // F1.2 — query da view v_latest_algo_score
    ShopeeQualityService,      // F1.3 — Quality Center (snapshot + alerts)
    ShopeeCampaignsService,    // F1.4 — Campaign Center (READ-ONLY Sprint 1)
    ShopeeRadarService,        // F1.5 — Radar de mercado Shopee
  ],
  exports:     [
    MarketplaceService, MarketplaceAdapterRegistry,
    ShopeeAlgoScoreService,    // F1.1 — exporta pra outros módulos (Listing Center)
    ShopeeQualityService,      // F1.3 — exporta pro Algorithm Score Pillar 3 reusar
  ],
})
export class MarketplaceModule {}
