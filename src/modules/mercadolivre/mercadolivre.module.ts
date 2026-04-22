import { Module } from '@nestjs/common'
import { MercadolivreController } from './mercadolivre.controller'
import { MercadolivreService } from './mercadolivre.service'

@Module({
  controllers: [MercadolivreController],
  providers: [MercadolivreService],
  exports: [MercadolivreService],
})
export class MercadolivreModule {}
