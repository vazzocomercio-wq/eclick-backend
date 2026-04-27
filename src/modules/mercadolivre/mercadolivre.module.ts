import { Module } from '@nestjs/common'
import { MercadolivreController } from './mercadolivre.controller'
import { MercadolivreService } from './mercadolivre.service'
import { MlBillingFetcherService } from './ml-billing-fetcher.service'
import { ScraperModule } from '../scraper/scraper.module'

@Module({
  imports: [ScraperModule],
  controllers: [MercadolivreController],
  providers: [MercadolivreService, MlBillingFetcherService],
  exports: [MercadolivreService, MlBillingFetcherService],
})
export class MercadolivreModule {}
