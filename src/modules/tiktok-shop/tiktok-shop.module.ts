import { Module, forwardRef } from '@nestjs/common'
import { TikTokShopController } from './tiktok-shop.controller'
import { TikTokShopService } from './tiktok-shop.service'
import { TikTokShopSyncCron } from './tiktok-shop-sync.cron'
import { StockModule } from '../stock/stock.module'

/** TikTok Shop (Personalizado) — OAuth + pedidos/produtos/conteúdo + sync.
 *  forwardRef(StockModule): TT-4b (venda TikTok → baixa estoque mestre) precisa
 *  do StockService, e StockModule já importa este módulo (TT-4a push). */
@Module({
  imports: [forwardRef(() => StockModule)],
  controllers: [TikTokShopController],
  providers: [TikTokShopService, TikTokShopSyncCron],
  exports: [TikTokShopService],
})
export class TikTokShopModule {}
