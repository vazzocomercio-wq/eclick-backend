import { Module } from '@nestjs/common'
import { SocialCommerceController } from './social-commerce.controller'
import { SocialCommerceService } from './social-commerce.service'
import { MetaCatalogService } from './meta-catalog.service'
import { SocialCommerceWorker } from './social-commerce.worker'

/** Onda 3 / S2 — Social Commerce (Instagram/Facebook Shop sync via Meta). */
@Module({
  controllers: [SocialCommerceController],
  providers:   [SocialCommerceService, MetaCatalogService, SocialCommerceWorker],
  exports:     [SocialCommerceService, MetaCatalogService],
})
export class SocialCommerceModule {}
