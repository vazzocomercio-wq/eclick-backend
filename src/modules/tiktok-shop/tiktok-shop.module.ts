import { Module } from '@nestjs/common'
import { TikTokShopController } from './tiktok-shop.controller'
import { TikTokShopService } from './tiktok-shop.service'
import { TikTokShopSyncCron } from './tiktok-shop-sync.cron'

/** TikTok Shop (Personalizado) — OAuth + pedidos/produtos/conteúdo + sync. */
@Module({
  controllers: [TikTokShopController],
  providers: [TikTokShopService, TikTokShopSyncCron],
  exports: [TikTokShopService],
})
export class TikTokShopModule {}
