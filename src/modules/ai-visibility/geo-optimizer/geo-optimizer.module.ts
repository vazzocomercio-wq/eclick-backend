import { Module } from '@nestjs/common'
import { AiModule } from '../../ai/ai.module'
import { MercadolivreModule } from '../../mercadolivre/mercadolivre.module'
import { GeoScoreModule } from '../geo-score/geo-score.module'
import { GeoOptimizerController } from './geo-optimizer.controller'
import { TitleRewriterService } from './services/title-rewriter.service'
import { DescriptionBuilderService } from './services/description-builder.service'
import { BaselineService } from './services/baseline.service'
import { MlPublisherService } from './services/ml-publisher.service'
import { ImpactTrackerService } from './services/impact-tracker.service'

@Module({
  // GeoScoreModule exporta ListingScraperService + GeoTelemetryService;
  // MercadolivreModule pro token do dono do anúncio (publish/rollback).
  imports:     [AiModule, GeoScoreModule, MercadolivreModule],
  controllers: [GeoOptimizerController],
  providers:   [TitleRewriterService, DescriptionBuilderService, BaselineService, MlPublisherService, ImpactTrackerService],
  exports:     [TitleRewriterService, DescriptionBuilderService],
})
export class GeoOptimizerModule {}
