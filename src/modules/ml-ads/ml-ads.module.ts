import { Module } from '@nestjs/common'
import { MlAdsController } from './ml-ads.controller'
import { MlAdsService } from './ml-ads.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports: [MercadolivreModule],
  controllers: [MlAdsController],
  providers: [MlAdsService],
})
export class MlAdsModule {}
