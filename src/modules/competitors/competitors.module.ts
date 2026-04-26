import { Module } from '@nestjs/common'
import { CompetitorsController } from './competitors.controller'
import { CompetitorsService } from './competitors.service'
import { ScraperModule } from '../scraper/scraper.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports: [ScraperModule, MercadolivreModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService],
})
export class CompetitorsModule {}
