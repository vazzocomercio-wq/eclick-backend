import { Module } from '@nestjs/common'
import { MercadolivreController } from './mercadolivre.controller'
import { MercadolivreService } from './mercadolivre.service'
import { MlBillingFetcherService } from './ml-billing-fetcher.service'
import { OrderDetailService } from './order-detail.service'
import { ScraperModule } from '../scraper/scraper.module'

@Module({
  imports: [ScraperModule],
  controllers: [MercadolivreController],
  providers: [MercadolivreService, MlBillingFetcherService, OrderDetailService],
  exports: [MercadolivreService, MlBillingFetcherService, OrderDetailService],
})
export class MercadolivreModule {}
