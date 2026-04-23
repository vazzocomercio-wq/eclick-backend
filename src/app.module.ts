import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { MercadolivreModule } from './modules/mercadolivre/mercadolivre.module'
import { OrdersModule } from './modules/orders/orders.module'

@Module({
  imports: [MercadolivreModule, OrdersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
