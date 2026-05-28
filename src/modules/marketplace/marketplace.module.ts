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

@Module({
  imports:     [MercadolivreModule], // pra MlBillingFetcherService
  controllers: [MarketplaceController, MarketplaceWebhooksController],
  providers:   [
    MercadoLivreAdapter, MagaluAdapter, ShopeeAdapter,
    MarketplaceAdapterRegistry, MarketplaceService,
    MarketplaceWebhooksService,
    ShopThrottleService, // F0.6 — throttle por shop_id pra ShopeeAdapter
  ],
  exports:     [MarketplaceService, MarketplaceAdapterRegistry],
})
export class MarketplaceModule {}
