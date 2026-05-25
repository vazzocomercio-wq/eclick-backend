import { Module } from '@nestjs/common'
import { AiModule } from '../../ai/ai.module'
import { MercadolivreModule } from '../../mercadolivre/mercadolivre.module'
import { GeoScoreController } from './geo-score.controller'
import { ListingScraperService } from './services/listing-scraper.service'
import { GeoScoreCalculatorService } from './services/geo-score-calculator.service'

@Module({
  imports:     [AiModule, MercadolivreModule],
  controllers: [GeoScoreController],
  providers:   [ListingScraperService, GeoScoreCalculatorService],
  exports:     [ListingScraperService, GeoScoreCalculatorService],
})
export class GeoScoreModule {}
