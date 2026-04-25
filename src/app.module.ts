import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { MercadolivreModule } from './modules/mercadolivre/mercadolivre.module'
import { OrdersModule } from './modules/orders/orders.module'
import { ProductsModule } from './modules/products/products.module'
import { SalesAggregatorModule } from './modules/sales-aggregator/sales-aggregator.module'
import { SuppliersModule } from './modules/suppliers/suppliers.module'
import { ComprasModule } from './modules/compras/compras.module'
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module'

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MercadolivreModule,
    OrdersModule,
    ProductsModule,
    SalesAggregatorModule,
    SuppliersModule,
    ComprasModule,
    PurchaseOrdersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
