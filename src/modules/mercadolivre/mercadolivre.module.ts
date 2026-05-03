import { Module } from '@nestjs/common'
import { MercadolivreController } from './mercadolivre.controller'
import { MercadolivreService } from './mercadolivre.service'
import { MlBillingFetcherService } from './ml-billing-fetcher.service'
import { OrderDetailService } from './order-detail.service'
import { MlQuestionsAiService } from './ml-questions-ai.service'
import { ScraperModule } from '../scraper/scraper.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports: [ScraperModule, AiModule],
  controllers: [MercadolivreController],
  providers: [MercadolivreService, MlBillingFetcherService, OrderDetailService, MlQuestionsAiService],
  exports: [MercadolivreService, MlBillingFetcherService, OrderDetailService, MlQuestionsAiService],
})
export class MercadolivreModule {}
