import { Module } from '@nestjs/common'
import { StoreCopilotController } from './store-copilot.controller'
import { StoreCopilotService } from './store-copilot.service'
import { AiModule } from '../ai/ai.module'
import { PricingAiModule } from '../pricing-ai/pricing-ai.module'
import { AdsCampaignsModule } from '../ads-campaigns/ads-campaigns.module'
import { SocialContentModule } from '../social-content/social-content.module'
import { KitsModule } from '../kits/kits.module'
import { StorefrontModule } from '../storefront/storefront.module'
import { StoreAutomationModule } from '../store-automation/store-automation.module'

/** Onda 4 / A4 — Copiloto da Loja (admin assistant). */
@Module({
  imports: [
    AiModule, PricingAiModule, AdsCampaignsModule, SocialContentModule,
    KitsModule, StorefrontModule, StoreAutomationModule,
  ],
  controllers: [StoreCopilotController],
  providers:   [StoreCopilotService],
  exports:     [StoreCopilotService],
})
export class StoreCopilotModule {}
