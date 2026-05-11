import { Module } from '@nestjs/common'
import { ExecutiveDashboardController } from './executive-dashboard.controller'
import { ExecutiveDashboardService } from './executive-dashboard.service'
import { ExecutiveDashboardCron } from './executive-dashboard.cron'
import { ExecutiveReputationService } from './executive-reputation.service'
import { ExecutiveReputationCron } from './executive-reputation.cron'
import { ExecutiveLogisticsService } from './executive-logistics.service'
import { ExecutiveLogisticsCron } from './executive-logistics.cron'
import { ExecutiveVisitsService } from './executive-visits.service'
import { ExecutiveVisitsCron } from './executive-visits.cron'
import { ExecutiveAdsService } from './executive-ads.service'
import { ExecutiveAdsCron } from './executive-ads.cron'
import { ExecutiveCardsController } from './cards/cards.controller'
import { FullFulfillmentCardService } from './cards/full-fulfillment-card.service'
import { FlexOpportunityCardService } from './cards/flex-opportunity-card.service'
import { VisitsLowConvCardService } from './cards/visits-low-conv-card.service'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

/**
 * F11 ML Executive Dashboard IA.
 * Sprint 1 (E1) — Foundation + Agregação (Postgres only).
 * Sprint 2 (E2) — Reputação via /users/{id} + risk detection + trend.
 * Sprint 3 (E3) — Logística: delays (/shipments/{id}/delays) + Flex.
 * Sprint 4 (E4) — Visitas (/items_visits/time_window) + conversão.
 * Sprint 5 (E5) — Ads Visibility (consumir ml_ads_* existente, sem F12 OAuth).
 */
@Module({
  imports:    [MercadolivreModule],
  controllers: [ExecutiveDashboardController, ExecutiveCardsController],
  providers: [
    ExecutiveDashboardService,
    ExecutiveDashboardCron,
    ExecutiveReputationService,
    ExecutiveReputationCron,
    ExecutiveLogisticsService,
    ExecutiveLogisticsCron,
    ExecutiveVisitsService,
    ExecutiveVisitsCron,
    ExecutiveAdsService,
    ExecutiveAdsCron,
    FullFulfillmentCardService,
    FlexOpportunityCardService,
    VisitsLowConvCardService,
  ],
  exports: [
    ExecutiveDashboardService,
    ExecutiveReputationService,
    ExecutiveLogisticsService,
    ExecutiveVisitsService,
    ExecutiveAdsService,
  ],
})
export class ExecutiveDashboardModule {}
