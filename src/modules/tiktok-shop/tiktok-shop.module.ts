import { Module } from '@nestjs/common'
import { TikTokShopController } from './tiktok-shop.controller'
import { TikTokShopService } from './tiktok-shop.service'

/** TikTok Shop (Personalizado) — OAuth + (futuro) pedidos/produtos/conteúdo. */
@Module({
  controllers: [TikTokShopController],
  providers: [TikTokShopService],
  exports: [TikTokShopService],
})
export class TikTokShopModule {}
