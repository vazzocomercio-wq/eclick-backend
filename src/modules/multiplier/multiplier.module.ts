import { Module } from '@nestjs/common'
import { MarketplaceModule } from '../marketplace/marketplace.module'
import { TikTokShopModule } from '../tiktok-shop/tiktok-shop.module'
import { ProductsModule } from '../products/products.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { AiModule } from '../ai/ai.module'
import { StockModule } from '../stock/stock.module'
import { MultiplierService } from './multiplier.service'
import { MultiplierController } from './multiplier.controller'

/** Multiplicação de Anúncios — orquestrador fino em cima dos publicadores
 *  existentes (Shopee add_item, TikTok create product, ML POST /items,
 *  storefront). */
@Module({
  imports:     [MarketplaceModule, TikTokShopModule, ProductsModule, MercadolivreModule, AiModule, StockModule],
  controllers: [MultiplierController],
  providers:   [MultiplierService],
  exports:     [MultiplierService],
})
export class MultiplierModule {}
