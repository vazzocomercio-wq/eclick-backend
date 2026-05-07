import { Module } from '@nestjs/common'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { MlAiCoreModule } from '../ml-ai-core/ml-ai-core.module'
import { IntelligenceHubModule } from '../intelligence-hub/intelligence-hub.module'
import { MlClaimsService } from './services/ml-claims.service'
import { MlReputationService } from './services/ml-reputation.service'
import { MlShippingDelayService } from './services/ml-shipping-delay.service'
import { MlClaimRemovalService } from './services/ml-claim-removal.service'
import { MlVerticalController } from './ml-vertical.controller'

/**
 * Intelligence Hub — Vertical ML Reputação & Alertas (MVP 2 do Pós-venda).
 *
 * Conecta o MercadoLivre ao Intelligence Hub existente do SaaS:
 *   - emite SignalDraft com analyzer='ml' e categoria por evento (claim_opened,
 *     mediation_started, shipping_delayed, reputation_dropped,
 *     critical_message, claim_removal_candidate)
 *   - AlertEngineService existente faz routing pra managers via
 *     alert_routing_rules → alert_deliveries (WhatsApp via Baileys)
 *
 * Ponto de entrada do webhook ML claims fica no MlWebhookDispatcher (módulo
 * separado), que delega pra MlClaimsService.handleClaimWebhook().
 */
@Module({
  imports:     [MercadolivreModule, MlAiCoreModule, IntelligenceHubModule],
  controllers: [MlVerticalController],
  providers:   [
    MlClaimsService,
    MlReputationService,
    MlShippingDelayService,
    MlClaimRemovalService,
  ],
  exports:     [
    MlClaimsService,
    MlReputationService,
    MlShippingDelayService,
    MlClaimRemovalService,
  ],
})
export class MlVerticalModule {}
