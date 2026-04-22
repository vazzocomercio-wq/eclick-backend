import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { MercadolivreModule } from './modules/mercadolivre/mercadolivre.module'

@Module({
  imports: [MercadolivreModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
