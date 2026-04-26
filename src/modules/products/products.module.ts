import { Module } from '@nestjs/common'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'
import { StockModule } from '../stock/stock.module'

@Module({
  imports:     [StockModule],
  controllers: [ProductsController],
  providers:   [ProductsService],
  exports:     [ProductsService],
})
export class ProductsModule {}
