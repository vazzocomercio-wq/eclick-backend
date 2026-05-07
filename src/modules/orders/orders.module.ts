import { Module } from '@nestjs/common'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports:     [MercadolivreModule],
  controllers: [OrdersController],
  providers:   [OrdersService],
})
export class OrdersModule {}
