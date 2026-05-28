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

@Module({
  imports:     [MercadolivreModule], // pra MlBillingFetcherService
  controllers: [
    MarketplaceController, MarketplaceWebhooksController,
    ShopeeListingsController, // F1.2 — GET /shopee/listings/scores
  ],
  providers:   [
    MercadoLivreAdapter, MagaluAdapter, ShopeeAdapter,
    MarketplaceAdapterRegistry, MarketplaceService,
    MarketplaceWebhooksService,
    ShopThrottleService,       // F0.6 — throttle por shop_id pra ShopeeAdapter
    ShopeeAlgoScoreService,    // F1.1 — Algorithm Score 4 pilares
    ShopeeListingsService,     // F1.2 — query da view v_latest_algo_score
  ],
  exports:     [
    MarketplaceService, MarketplaceAdapterRegistry,
    ShopeeAlgoScoreService,    // F1.1 — exporta pra outros módulos (Listing Center)
  ],
})
export class MarketplaceModule {}
