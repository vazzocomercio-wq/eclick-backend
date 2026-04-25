import { Module } from '@nestjs/common'
import { MercadolivreController } from './mercadolivre.controller'
import { MercadolivreService } from './mercadolivre.service'
import { ScraperModule } from '../scraper/scraper.module'

@Module({
  imports: [ScraperModule],
  controllers: [MercadolivreController],
  providers: [MercadolivreService],
  exports: [MercadolivreService],
})
export class MercadolivreModule {}
