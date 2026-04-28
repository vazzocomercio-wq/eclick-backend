import { Module } from '@nestjs/common'
import { AdminController } from './admin.controller'
import { SalesAggregatorModule } from '../sales-aggregator/sales-aggregator.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports:     [SalesAggregatorModule, MercadolivreModule],
  controllers: [AdminController],
})
export class AdminModule {}
