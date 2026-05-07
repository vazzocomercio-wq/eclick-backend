import { Module } from '@nestjs/common'
import { AiModule } from '../ai/ai.module'
import { MlAiCoreService } from './ml-ai-core.service'

/**
 * Núcleo compartilhado de IA para os módulos ML (perguntas pré-venda e
 * mensagens pós-venda). Centraliza prompts e classificação. Consumido por
 * MercadolivreModule (perguntas) e MlPostsaleModule (pós-venda).
 */
@Module({
  imports:   [AiModule],
  providers: [MlAiCoreService],
  exports:   [MlAiCoreService],
})
export class MlAiCoreModule {}
