import { Module } from '@nestjs/common'
import { ProductsAnalyticsController } from './products-analytics.controller'
import { ProductsAnalyticsService } from './products-analytics.service'

/** Onda 3 / S6 — Analytics social/ads do produto. */
@Module({
  controllers: [ProductsAnalyticsController],
  providers:   [ProductsAnalyticsService],
  exports:     [ProductsAnalyticsService],
})
export class ProductsAnalyticsModule {}
