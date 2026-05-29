import { Module } from '@nestjs/common'
import { ShopeeAffiliateController } from './shopee-affiliate.controller'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { OpportunityScoreService } from './opportunity-score.service'
import { LinkStudioService } from './link-studio.service'
import { LinkRedirectController } from './link-redirect.controller'
import { AttributionService } from './attribution.service'

/** F18 Fase 2 — Lado Afiliado. Módulo SEPARADO do marketplace/ (T2):
 *  Affiliate API (affiliate.shopee.com.br) tem auth/escopo distinto do
 *  Open Platform vendedor.
 *
 *  Sprint 1: Opportunity Score + Discovery + Link Studio + Attribution.
 *  Sprint 2 adiciona ingestion (App ID/Secret) + Content Studio. */
@Module({
  controllers: [ShopeeAffiliateController, LinkRedirectController],
  providers:   [ShopeeAffiliateService, OpportunityScoreService, LinkStudioService, AttributionService],
  exports:     [OpportunityScoreService, ShopeeAffiliateService, LinkStudioService, AttributionService],
})
export class ShopeeAffiliateModule {}
