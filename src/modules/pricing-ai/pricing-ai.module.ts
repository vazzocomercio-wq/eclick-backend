import { Module } from '@nestjs/common'
import { PricingAiController } from './pricing-ai.controller'
import { PricingAiService } from './pricing-ai.service'
import { AiModule } from '../ai/ai.module'

/** Onda 4 / A1 — Pricing AI: sugestões de preço com 3 cenários
 *  (conservador / ótimo / agressivo) por produto, com auto-apply opcional. */
@Module({
  imports:     [AiModule],
  controllers: [PricingAiController],
  providers:   [PricingAiService],
  exports:     [PricingAiService],
})
export class PricingAiModule {}
