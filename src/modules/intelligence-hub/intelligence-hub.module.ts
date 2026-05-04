import { Module } from '@nestjs/common'
import { ChannelsModule } from '../channels/channels.module'
import { AlertManagersController } from './alert-managers.controller'
import { AlertManagersService } from './alert-managers.service'
import { AlertHubController } from './alert-hub.controller'
import { AlertHubConfigService } from './alert-hub-config.service'
import { AlertRoutingRulesService } from './alert-routing-rules.service'
import { AlertSignalsService } from './alert-signals.service'
import { AlertDeliveriesService } from './alert-deliveries.service'
import { EstoqueAnalyzer } from './analyzers/estoque.analyzer'
import { ComprasAnalyzer } from './analyzers/compras.analyzer'
import { PrecoAnalyzer } from './analyzers/preco.analyzer'
import { MargemAnalyzer } from './analyzers/margem.analyzer'
import { AnalyzersController } from './analyzers/analyzers.controller'
import { AnalyzersSchedulerService } from './analyzers/analyzers-scheduler.service'
import { CrossIntelService } from './cross-intel/cross-intel.service'
import { LearningService } from './learning/learning.service'
import { AlertHubStatsService } from './alert-hub-stats.service'
import { AlertEngineService } from './alert-engine.service'
import { WhatsAppDeliveryService } from './delivery/whatsapp-delivery.service'
import { DigestService } from './delivery/digest.service'
import { AlertResponseService } from './delivery/alert-response.service'

/**
 * Intelligence Hub — Sprint IH-1.
 *
 * Escopo atual: gestores (CRUD + verify-phone), config global do hub,
 * routing rules (CRUD + defaults).
 *
 * Pendente (sprints seguintes):
 *   IH-2: 5 analyzers + AlertEngine + Dispatcher
 *   IH-3: WhatsApp delivery + Digest + ResponseHandler + feed/stats
 *   IH-4: CrossIntel + Learning
 *   IH-5: Frontend config + onboarding wizard
 *
 * Importa ChannelsModule pra consumir BaileysProvider no envio do código
 * de verificação. ChannelsModule já exporta BaileysProvider (Bug #1 Active
 * mitigado lá).
 */
@Module({
  imports:     [ChannelsModule],
  controllers: [AlertManagersController, AlertHubController, AnalyzersController],
  providers:   [
    AlertManagersService,
    AlertHubConfigService,
    AlertRoutingRulesService,
    AlertSignalsService,
    AlertDeliveriesService,
    AlertEngineService,
    WhatsAppDeliveryService,
    DigestService,
    AlertResponseService,
    AnalyzersSchedulerService,
    CrossIntelService,
    LearningService,
    AlertHubStatsService,
    EstoqueAnalyzer,
    ComprasAnalyzer,
    PrecoAnalyzer,
    MargemAnalyzer,
  ],
  exports:     [
    AlertManagersService,
    AlertHubConfigService,
    AlertRoutingRulesService,
    AlertSignalsService,
    AlertDeliveriesService,
    AlertEngineService,
    WhatsAppDeliveryService,
    DigestService,
    AlertResponseService,
    CrossIntelService,
    LearningService,
    AlertHubStatsService,
    EstoqueAnalyzer,
    ComprasAnalyzer,
    PrecoAnalyzer,
    MargemAnalyzer,
  ],
})
export class IntelligenceHubModule {}
