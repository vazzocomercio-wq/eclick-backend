import { Module, forwardRef } from '@nestjs/common'
import { TikTokShopController } from './tiktok-shop.controller'
import { TikTokShopService } from './tiktok-shop.service'
import { TikTokShopSyncCron } from './tiktok-shop-sync.cron'
import { TikTokFinanceIngestService } from './tiktok-finance-ingest.service'
import { StockModule } from '../stock/stock.module'
import { ChannelSettingsModule } from '../channel-settings/channel-settings.module'

/** TikTok Shop (Personalizado) — OAuth + pedidos/produtos/conteúdo + sync.
 *  forwardRef(StockModule): TT-4b (venda TikTok → baixa estoque mestre) precisa
 *  do StockService, e StockModule já importa este módulo (TT-4a push).
 *  ChannelSettingsModule: TT-5b lê a comissão TikTok da org pra estimar
 *  platform_fee nos pedidos. */
@Module({
  imports: [forwardRef(() => StockModule), ChannelSettingsModule],
  controllers: [TikTokShopController],
  providers: [TikTokShopService, TikTokShopSyncCron, TikTokFinanceIngestService],
  exports: [TikTokShopService],
})
export class TikTokShopModule {}
