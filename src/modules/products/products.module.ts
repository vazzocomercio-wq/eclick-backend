import { Module } from '@nestjs/common'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'
import { StockModule } from '../stock/stock.module'
import { CreativeModule } from '../creative/creative.module'

@Module({
  imports:     [StockModule, CreativeModule],
  controllers: [ProductsController],
  providers:   [ProductsService],
  exports:     [ProductsService],
})
export class ProductsModule {}
