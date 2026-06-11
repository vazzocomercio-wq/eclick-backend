import { Module, forwardRef } from '@nestjs/common'
import { StockService } from './stock.service'
import { StockController } from './stock.controller'
import { StockCron } from './stock.cron'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { TikTokShopModule } from '../tiktok-shop/tiktok-shop.module'
import { MarketplaceModule } from '../marketplace/marketplace.module'

@Module({
  // MarketplaceModule: ShopeeStockSyncService (F18 Fase C — propaga estoque →
  // anúncio Shopee no recalcAndPropagate). forwardRef: marketplace agora também
  // importa stock (venda Shopee → baixa estoque mestre na ingestão de pedidos).
  imports: [MercadolivreModule, forwardRef(() => TikTokShopModule), forwardRef(() => MarketplaceModule)],
  controllers: [StockController],
  providers: [StockService, StockCron],
  exports: [StockService],
})
export class StockModule {}
