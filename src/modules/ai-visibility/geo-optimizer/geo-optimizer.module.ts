import { Module } from '@nestjs/common'
import { AiModule } from '../../ai/ai.module'
import { MercadolivreModule } from '../../mercadolivre/mercadolivre.module'
import { TikTokShopModule } from '../../tiktok-shop/tiktok-shop.module'
import { GeoScoreModule } from '../geo-score/geo-score.module'
import { GeoOptimizerController } from './geo-optimizer.controller'
import { TitleRewriterService } from './services/title-rewriter.service'
import { DescriptionBuilderService } from './services/description-builder.service'
import { BaselineService } from './services/baseline.service'
import { MlPublisherService } from './services/ml-publisher.service'
import { TiktokPublisherService } from './services/tiktok-publisher.service'
import { ImpactTrackerService } from './services/impact-tracker.service'
import { RankSimulatorService } from './services/rank-simulator.service'
import { DraftGeoService } from './services/draft-geo.service'

@Module({
  // GeoScoreModule exporta ListingScraperService + GeoTelemetryService;
  // MercadolivreModule pro token do dono do anúncio (publish/rollback);
  // TikTokShopModule pro partial_edit do anúncio TikTok (publish/rollback).
  imports:     [AiModule, GeoScoreModule, MercadolivreModule, TikTokShopModule],
  controllers: [GeoOptimizerController],
  providers:   [TitleRewriterService, DescriptionBuilderService, BaselineService, MlPublisherService, TiktokPublisherService, ImpactTrackerService, RankSimulatorService, DraftGeoService],
  exports:     [TitleRewriterService, DescriptionBuilderService, RankSimulatorService],
})
export class GeoOptimizerModule {}
