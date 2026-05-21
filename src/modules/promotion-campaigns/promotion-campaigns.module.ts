import { Module } from '@nestjs/common'
import { PromotionCampaignsController } from './promotion-campaigns.controller'
import { PromotionCampaignsService } from './promotion-campaigns.service'

@Module({
  controllers: [PromotionCampaignsController],
  providers:   [PromotionCampaignsService],
  exports:     [PromotionCampaignsService],
})
export class PromotionCampaignsModule {}
