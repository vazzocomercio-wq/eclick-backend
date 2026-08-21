import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'
import { ExecutiveDashboardModule } from '../executive-dashboard/executive-dashboard.module'
import { MlReputationController } from './ml-reputation.controller'
import { MlReputationService } from './ml-reputation.service'
import { MlReputationDataService } from './ml-reputation-data.service'
import { MlReputationRulesService } from './ml-reputation-rules.service'
import { MlReputationCron } from './ml-reputation.cron'

/**
 * Módulo de Reputação Mercado Livre — central de prevenção.
 *
 *   • Regras versionadas (ml_reputation_rule_sets) — período 60/365, limiar
 *     de 68 vendas a partir de 10/09/2026, faixas por métrica, níveis de risco.
 *   • Motor puro (ml-reputation.engine.ts) com testes de borda.
 *   • Cálculo LOCAL a partir de orders + ml_claims + ml_shipment_delays,
 *     sempre lado a lado com o OFICIAL (ExecutiveReputationService,
 *     GET /users/{id}) — nunca substitui a reputação oficial.
 *   • Recalcula por webhook (MlWebhookDispatcher → scheduleRecalc), cron e
 *     botão; alerta via Intelligence Hub (alert_signals) com dedupe/cooldown;
 *     Socket.IO `reputation:updated` pra UI.
 */
@Module({
  imports:     [MercadolivreModule, IntelligenceHubModule, ExecutiveDashboardModule],
  controllers: [MlReputationController],
  providers:   [MlReputationService, MlReputationDataService, MlReputationRulesService, MlReputationCron],
  exports:     [MlReputationService],
})
export class MlReputationModule {}
