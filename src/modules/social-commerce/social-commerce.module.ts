import { Module } from '@nestjs/common'
import { SocialCommerceController } from './social-commerce.controller'
import { SocialCommerceService } from './social-commerce.service'
import { MetaCatalogService } from './meta-catalog.service'

/** Onda 3 / S2 — Social Commerce (Instagram/Facebook Shop sync via Meta). */
@Module({
  controllers: [SocialCommerceController],
  providers:   [SocialCommerceService, MetaCatalogService],
  exports:     [SocialCommerceService, MetaCatalogService],
})
export class SocialCommerceModule {}
