import { Module } from '@nestjs/common'
import { MlAdsController } from './ml-ads.controller'
import { MlAdsService } from './ml-ads.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

@Module({
  imports: [MercadolivreModule, ActiveBridgeModule],
  controllers: [MlAdsController],
  providers: [MlAdsService],
  exports: [MlAdsService],
})
export class MlAdsModule {}
