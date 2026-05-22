import { Module } from '@nestjs/common'
import { StorefrontAnalyticsService } from './storefront-analytics.service'
import { StorefrontAnalyticsController } from './storefront-analytics.controller'

@Module({
  controllers: [StorefrontAnalyticsController],
  providers:   [StorefrontAnalyticsService],
  exports:     [StorefrontAnalyticsService],
})
export class StorefrontAnalyticsModule {}
