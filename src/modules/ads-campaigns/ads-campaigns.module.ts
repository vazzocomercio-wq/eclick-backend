import { Module } from '@nestjs/common'
import { AdsCampaignsController } from './ads-campaigns.controller'
import { AdsCampaignsService } from './ads-campaigns.service'
import { MetaAdsService } from './meta-ads.service'
import { AdsMetricsWorker } from './ads-metrics.worker'
import { AiModule } from '../ai/ai.module'

/** Onda 3 / S4+S6 — Ads Hub: gera + publica campanhas + sync métricas. */
@Module({
  imports:     [AiModule],
  controllers: [AdsCampaignsController],
  providers:   [AdsCampaignsService, MetaAdsService, AdsMetricsWorker],
  exports:     [AdsCampaignsService, MetaAdsService],
})
export class AdsCampaignsModule {}
