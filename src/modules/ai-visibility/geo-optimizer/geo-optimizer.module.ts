import { Module } from '@nestjs/common'
import { AiModule } from '../../ai/ai.module'
import { GeoScoreModule } from '../geo-score/geo-score.module'
import { GeoOptimizerController } from './geo-optimizer.controller'
import { TitleRewriterService } from './services/title-rewriter.service'
import { DescriptionBuilderService } from './services/description-builder.service'

@Module({
  imports:     [AiModule, GeoScoreModule], // GeoScoreModule exporta ListingScraperService
  controllers: [GeoOptimizerController],
  providers:   [TitleRewriterService, DescriptionBuilderService],
  exports:     [TitleRewriterService, DescriptionBuilderService],
})
export class GeoOptimizerModule {}
