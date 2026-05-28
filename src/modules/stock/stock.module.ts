import { Module } from '@nestjs/common'
import { StockService } from './stock.service'
import { StockController } from './stock.controller'
import { StockCron } from './stock.cron'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { TikTokShopModule } from '../tiktok-shop/tiktok-shop.module'

@Module({
  imports: [MercadolivreModule, TikTokShopModule],
  controllers: [StockController],
  providers: [StockService, StockCron],
  exports: [StockService],
})
export class StockModule {}
