import { Module } from '@nestjs/common'
import { AnalyticsAccountsController } from './accounts/analytics-accounts.controller'
import { AnalyticsAccountsService } from './accounts/analytics-accounts.service'
import { OrganicCollectorController } from './organic/organic-collector.controller'
import { OrganicCollectorService } from './organic/organic-collector.service'
import { OrganicCollectorWorker } from './organic/organic-collector.worker'
import { AnalyticsOverviewController } from './overview/analytics-overview.controller'
import { AnalyticsOverviewService } from './overview/analytics-overview.service'

/**
 * Analytics Hub — visão unificada de performance da org cruzando TODAS as
 * redes/contas: orgânico (IG/FB), pago (Meta/Google Ads), marketplace (ML),
 * GEO (visibilidade em IA) e vitrine. Hospedado no SaaS; puxa o que vive no
 * Active via bridge (fase posterior).
 *
 * Subpastas:
 * - accounts/  — registro multi-conta/multi-rede (F0)
 * - organic/   — coleta orgânica direta IG (F1) + insights de conta (F2)
 * - aggregator/— agregação cross-source (F4)
 */
@Module({
  controllers: [AnalyticsAccountsController, OrganicCollectorController, AnalyticsOverviewController],
  providers:   [AnalyticsAccountsService, OrganicCollectorService, OrganicCollectorWorker, AnalyticsOverviewService],
  exports:     [AnalyticsAccountsService, OrganicCollectorService],
})
export class AnalyticsHubModule {}
