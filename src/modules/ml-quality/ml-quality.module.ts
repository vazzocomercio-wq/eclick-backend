import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlQualityApiClient } from './ml-quality-api.client'
import { MlQualityService } from './ml-quality.service'
import { MlQualitySyncService } from './ml-quality-sync.service'
import { MlQualityController } from './ml-quality.controller'

@Module({
  imports:     [MercadolivreModule],
  providers:   [MlQualityApiClient, MlQualityService, MlQualitySyncService],
  controllers: [MlQualityController],
  exports:     [MlQualityService, MlQualitySyncService],
})
export class MlQualityModule {}
