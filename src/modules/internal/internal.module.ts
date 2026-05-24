import { Module } from '@nestjs/common'
import { InternalController } from './internal.controller'
import { InternalKeyGuard } from './internal-key.guard'
import { SocialVideoBridgeService } from './social-video-bridge.service'
import { InternalProductsSignalsService } from './internal-products-signals.service'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'
import { CreativeModule } from '../creative/creative.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [IntelligenceHubModule, MercadolivreModule, CanvaOauthModule, CreativeModule, AiModule],
  controllers: [InternalController],
  providers:   [InternalKeyGuard, SocialVideoBridgeService, InternalProductsSignalsService],
})
export class InternalModule {}
