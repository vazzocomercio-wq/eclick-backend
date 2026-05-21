import { Module } from '@nestjs/common'
import { ProductReviewsService } from './product-reviews.service'
import { ProductReviewsController, ProductReviewsPublicController } from './product-reviews.controller'
import { StorefrontCustomersModule } from '../storefront-customers/storefront-customers.module'

@Module({
  imports:     [StorefrontCustomersModule],
  controllers: [ProductReviewsController, ProductReviewsPublicController],
  providers:   [ProductReviewsService],
  exports:     [ProductReviewsService],
})
export class ProductReviewsModule {}
