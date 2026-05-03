import { Module } from '@nestjs/common'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'
import { CanvaController } from './canva.controller'
import { CanvaService } from './canva.service'

@Module({
  imports:     [CanvaOauthModule],   // pra reusar getValidAccessToken + uploadAndOpenDesign
  controllers: [CanvaController],
  providers:   [CanvaService],
  exports:     [CanvaService],
})
export class CanvaModule {}
