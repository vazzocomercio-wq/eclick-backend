import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlQualityApiClient } from './ml-quality-api.client'
import { MlQualityService } from './ml-quality.service'
import { MlQualitySyncService } from './ml-quality-sync.service'
import { MlLabelsService } from './ml-labels.service'
import { MlQualityController } from './ml-quality.controller'

@Module({
  imports:     [MercadolivreModule],
  providers:   [MlQualityApiClient, MlQualityService, MlQualitySyncService, MlLabelsService],
  controllers: [MlQualityController],
  exports:     [MlQualityService, MlQualitySyncService, MlLabelsService],
})
export class MlQualityModule {}
