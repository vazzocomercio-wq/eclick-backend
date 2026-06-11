import { Module } from '@nestjs/common'
import { MarketplaceModule } from '../marketplace/marketplace.module'
import { TikTokShopModule } from '../tiktok-shop/tiktok-shop.module'
import { ProductsModule } from '../products/products.module'
import { MultiplierService } from './multiplier.service'
import { MultiplierController } from './multiplier.controller'

/** Multiplicação de Anúncios — orquestrador fino em cima dos publicadores
 *  existentes (Shopee add_item, TikTok create product, storefront). */
@Module({
  imports:     [MarketplaceModule, TikTokShopModule, ProductsModule],
  controllers: [MultiplierController],
  providers:   [MultiplierService],
  exports:     [MultiplierService],
})
export class MultiplierModule {}
