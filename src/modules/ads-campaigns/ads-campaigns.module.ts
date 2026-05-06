import { Module } from '@nestjs/common'
import { AdsCampaignsController } from './ads-campaigns.controller'
import { AdsCampaignsService } from './ads-campaigns.service'
import { AiModule } from '../ai/ai.module'

/** Onda 3 / S4 — Ads Hub: gera campanhas Meta/Google/TikTok com IA. */
@Module({
  imports:     [AiModule],
  controllers: [AdsCampaignsController],
  providers:   [AdsCampaignsService],
  exports:     [AdsCampaignsService],
})
export class AdsCampaignsModule {}
