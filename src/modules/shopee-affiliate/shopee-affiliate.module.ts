import { Module } from '@nestjs/common'
import { ShopeeAffiliateController } from './shopee-affiliate.controller'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { OpportunityScoreService } from './opportunity-score.service'
import { LinkStudioService } from './link-studio.service'
import { LinkRedirectController } from './link-redirect.controller'
import { AttributionService } from './attribution.service'
import { ContentStudioService } from './content-studio.service'
import { AiModule } from '../ai/ai.module'

/** F18 Fase 2 — Lado Afiliado. Módulo SEPARADO do marketplace/ (T2):
 *  Affiliate API (affiliate.shopee.com.br) tem auth/escopo distinto do
 *  Open Platform vendedor.
 *
 *  Discovery + Opportunity Score + Link Studio + Attribution + Content
 *  Studio (IA). Ingestion real (App ID/Secret) = Sprint 2 com creds. */
@Module({
  imports:     [AiModule], // F2.6 — LlmService pro Content Studio
  controllers: [ShopeeAffiliateController, LinkRedirectController],
  providers:   [
    ShopeeAffiliateService, OpportunityScoreService, LinkStudioService,
    AttributionService, ContentStudioService,
  ],
  exports:     [
    OpportunityScoreService, ShopeeAffiliateService, LinkStudioService,
    AttributionService, ContentStudioService,
  ],
})
export class ShopeeAffiliateModule {}
