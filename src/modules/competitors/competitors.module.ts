import { Module } from '@nestjs/common'
import { CompetitorsController } from './competitors.controller'
import { CompetitorsService } from './competitors.service'
import { ScraperModule } from '../scraper/scraper.module'

@Module({
  imports: [ScraperModule],
  controllers: [CompetitorsController],
  providers: [CompetitorsService],
})
export class CompetitorsModule {}
