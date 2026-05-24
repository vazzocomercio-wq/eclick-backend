import { Module } from '@nestjs/common'
import { InternalController } from './internal.controller'
import { InternalKeyGuard } from './internal-key.guard'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'

@Module({
  imports:     [IntelligenceHubModule, MercadolivreModule, CanvaOauthModule],
  controllers: [InternalController],
  providers:   [InternalKeyGuard],
})
export class InternalModule {}
