import { Module } from '@nestjs/common'
import { ShopeeAffiliateController } from './shopee-affiliate.controller'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { OpportunityScoreService } from './opportunity-score.service'

/** F18 Fase 2 — Lado Afiliado. Módulo SEPARADO do marketplace/ (T2):
 *  Affiliate API (affiliate.shopee.com.br) tem auth/escopo distinto do
 *  Open Platform vendedor.
 *
 *  Sprint 1: Opportunity Score + Discovery (READ). Sprint 2 adiciona
 *  ingestion (App ID/Secret), Link Studio, Attribution, Content Studio. */
@Module({
  controllers: [ShopeeAffiliateController],
  providers:   [ShopeeAffiliateService, OpportunityScoreService],
  exports:     [OpportunityScoreService, ShopeeAffiliateService],
})
export class ShopeeAffiliateModule {}
