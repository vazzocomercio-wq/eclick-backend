import { Module } from '@nestjs/common'
import { AiModule } from '../../ai/ai.module'
import { MercadolivreModule } from '../../mercadolivre/mercadolivre.module'
import { GeoScoreController } from './geo-score.controller'
import { ListingScraperService } from './services/listing-scraper.service'
import { GeoScoreCalculatorService } from './services/geo-score-calculator.service'
import { GeoRecommendationsService } from './services/geo-recommendations.service'
import { GeoTelemetryService } from './services/geo-telemetry.service'
import { ScoreProcessorService } from './workers/score-processor.service'

@Module({
  imports:     [AiModule, MercadolivreModule],
  controllers: [GeoScoreController],
  providers:   [
    ListingScraperService,
    GeoScoreCalculatorService,
    GeoRecommendationsService,
    GeoTelemetryService,
    ScoreProcessorService,
  ],
  exports:     [ListingScraperService, GeoScoreCalculatorService, GeoRecommendationsService, GeoTelemetryService],
})
export class GeoScoreModule {}
