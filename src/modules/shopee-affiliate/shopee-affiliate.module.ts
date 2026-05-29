import { Module } from '@nestjs/common'
import { ShopeeAffiliateController } from './shopee-affiliate.controller'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { OpportunityScoreService } from './opportunity-score.service'
import { LinkStudioService } from './link-studio.service'
import { LinkRedirectController } from './link-redirect.controller'
import { AttributionService } from './attribution.service'
import { ContentStudioService } from './content-studio.service'
import { MatchScoreService } from './matchmaker/match-score.service'
import { MatchmakerService } from './matchmaker/matchmaker.service'
import { MatchmakerController } from './matchmaker/matchmaker.controller'
import { PonteMetricsService } from './matchmaker/ponte-metrics.service'
import { AiModule } from '../ai/ai.module'

/** F18 Fase 2 + 4 — Lado Afiliado + A Ponte. Módulo SEPARADO do
 *  marketplace/ (T2): Affiliate API tem auth/escopo distinto.
 *
 *  Discovery + Opportunity Score + Link Studio + Attribution + Content
 *  Studio (IA) + Matchmaker (A Ponte vendedor↔afiliado). */
@Module({
  imports:     [AiModule], // F2.6 — LlmService pro Content Studio
  controllers: [ShopeeAffiliateController, LinkRedirectController, MatchmakerController],
  providers:   [
    ShopeeAffiliateService, OpportunityScoreService, LinkStudioService,
    AttributionService, ContentStudioService,
    MatchScoreService, MatchmakerService, PonteMetricsService,
  ],
  exports:     [
    OpportunityScoreService, ShopeeAffiliateService, LinkStudioService,
    AttributionService, ContentStudioService, MatchScoreService, MatchmakerService,
  ],
})
export class ShopeeAffiliateModule {}
