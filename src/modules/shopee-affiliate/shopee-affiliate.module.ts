import { Module } from '@nestjs/common'
import { ShopeeAffiliateController } from './shopee-affiliate.controller'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { OpportunityScoreService } from './opportunity-score.service'
import { LinkStudioService } from './link-studio.service'
import { LinkRedirectController } from './link-redirect.controller'

/** F18 Fase 2 — Lado Afiliado. Módulo SEPARADO do marketplace/ (T2):
 *  Affiliate API (affiliate.shopee.com.br) tem auth/escopo distinto do
 *  Open Platform vendedor.
 *
 *  Sprint 1: Opportunity Score + Discovery + Link Studio. Sprint 2 adiciona
 *  ingestion (App ID/Secret), Attribution Analytics, Content Studio. */
@Module({
  controllers: [ShopeeAffiliateController, LinkRedirectController],
  providers:   [ShopeeAffiliateService, OpportunityScoreService, LinkStudioService],
  exports:     [OpportunityScoreService, ShopeeAffiliateService, LinkStudioService],
})
export class ShopeeAffiliateModule {}
