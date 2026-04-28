import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MercadoLivreAdapter } from './adapters/ml.adapter'
import { MarketplaceAdapterRegistry } from './adapters/registry'
import { MarketplaceService } from './marketplace.service'

@Module({
  imports:   [MercadolivreModule], // pra MlBillingFetcherService
  providers: [MercadoLivreAdapter, MarketplaceAdapterRegistry, MarketplaceService],
  exports:   [MarketplaceService, MarketplaceAdapterRegistry],
})
export class MarketplaceModule {}
