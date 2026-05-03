import { Module } from '@nestjs/common'
import { MarketplaceChannelsController } from './marketplace-channels.controller'
import { MarketplaceChannelsService } from './marketplace-channels.service'

@Module({
  controllers: [MarketplaceChannelsController],
  providers:   [MarketplaceChannelsService],
  exports:     [MarketplaceChannelsService],
})
export class MarketplaceChannelsModule {}
