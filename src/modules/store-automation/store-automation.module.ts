import { Module } from '@nestjs/common'
import { StoreAutomationController } from './store-automation.controller'
import { StoreAutomationService } from './store-automation.service'
import { StoreAutomationEngine } from './store-automation.engine'
import { StoreAutomationExecutor } from './store-automation.executor'
import { StoreAutomationWorker } from './store-automation.worker'
import { ActiveBridgeClient } from './active-bridge.client'
import { PricingAiModule } from '../pricing-ai/pricing-ai.module'
import { AdsCampaignsModule } from '../ads-campaigns/ads-campaigns.module'
import { SocialContentModule } from '../social-content/social-content.module'

/** Onda 4 / A3 — Automações Autônomas da Loja. */
@Module({
  imports:     [PricingAiModule, AdsCampaignsModule, SocialContentModule],
  controllers: [StoreAutomationController],
  providers:   [
    StoreAutomationService,
    StoreAutomationEngine,
    StoreAutomationExecutor,
    StoreAutomationWorker,
    ActiveBridgeClient,
  ],
  exports:     [StoreAutomationService, StoreAutomationEngine],
})
export class StoreAutomationModule {}
