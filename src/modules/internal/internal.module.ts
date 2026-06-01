import { Module } from '@nestjs/common'
import { InternalController } from './internal.controller'
import { InternalEnrichmentController } from './internal-enrichment.controller'
import { InternalKeyGuard } from './internal-key.guard'
import { SocialVideoBridgeService } from './social-video-bridge.service'
import { InternalProductsSignalsService } from './internal-products-signals.service'
import { DidAvatarService } from './did-avatar.service'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'
import { CreativeModule } from '../creative/creative.module'
import { AiModule } from '../ai/ai.module'
import { EnrichmentModule } from '../enrichment/enrichment.module'
import { MlAdsModule } from '../ml-ads/ml-ads.module'

@Module({
  imports:     [IntelligenceHubModule, MercadolivreModule, CanvaOauthModule, CreativeModule, AiModule, EnrichmentModule, MlAdsModule],
  controllers: [InternalController, InternalEnrichmentController],
  providers:   [InternalKeyGuard, SocialVideoBridgeService, InternalProductsSignalsService, DidAvatarService],
})
export class InternalModule {}
