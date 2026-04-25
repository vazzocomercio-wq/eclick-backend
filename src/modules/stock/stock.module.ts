import { Module } from '@nestjs/common'
import { StockService } from './stock.service'
import { StockController } from './stock.controller'
import { StockCron } from './stock.cron'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports: [MercadolivreModule],
  controllers: [StockController],
  providers: [StockService, StockCron],
  exports: [StockService],
})
export class StockModule {}
