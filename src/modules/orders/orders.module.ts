import { Module } from '@nestjs/common'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { AccountLabelsModule } from '../account-labels/account-labels.module'

@Module({
  imports:     [MercadolivreModule, AccountLabelsModule],
  controllers: [OrdersController],
  providers:   [OrdersService],
})
export class OrdersModule {}
