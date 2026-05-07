import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlCampaignsApiClient } from './ml-campaigns-api.client'
import { MlCampaignsService } from './ml-campaigns.service'
import { MlCampaignsSyncService } from './ml-campaigns-sync.service'
import { MlCampaignsCostService } from './ml-campaigns-cost.service'
import { MlCampaignsDecisionService } from './ml-campaigns-decision.service'
import { MlCampaignsController } from './ml-campaigns.controller'

@Module({
  imports:     [MercadolivreModule],
  providers:   [
    MlCampaignsApiClient,
    MlCampaignsService,
    MlCampaignsSyncService,
    MlCampaignsCostService,
    MlCampaignsDecisionService,
  ],
  controllers: [MlCampaignsController],
  exports:     [MlCampaignsService, MlCampaignsSyncService, MlCampaignsDecisionService],
})
export class MlCampaignsModule {}
