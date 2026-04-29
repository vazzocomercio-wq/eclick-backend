import { Module } from '@nestjs/common'
import { CredentialsModule } from '../credentials/credentials.module'
import { LlmService } from './llm.service'
import { AiSettingsService } from './ai-settings.service'
import { AiSettingsController } from './ai-settings.controller'

/** Sprint AI-ABS-1 — abstração multi-provider de IA. Centraliza o roteamento
 * de chamadas (Anthropic / OpenAI), config per-org per-feature em
 * ai_feature_settings, e logging em ai_usage_log com fallback tracking.
 *
 * Não substitui ainda os módulos legados (atendente-ia, ads-ai) — esses
 * mantêm suas próprias chamadas e migram em sprints futuras pra evitar
 * regressão em produção. Campaigns nasce já usando. */
@Module({
  imports:     [CredentialsModule],
  controllers: [AiSettingsController],
  providers:   [LlmService, AiSettingsService],
  exports:     [LlmService, AiSettingsService],
})
export class AiModule {}
