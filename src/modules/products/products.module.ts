import { Module } from '@nestjs/common'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports:     [MercadolivreModule],
  controllers: [ProductsController],
  providers:   [ProductsService],
  exports:     [ProductsService],
})
export class ProductsModule {}
