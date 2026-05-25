import { Module } from '@nestjs/common'
import { AiVisibilityController } from './ai-visibility.controller'

/**
 * AI Visibility OS — GEO (Generative Engine Optimization).
 * Mede e melhora a presença dos produtos da org nos motores de IA.
 * Subpastas: geo-score/ (auditoria+nota), geo-optimizer/ (recomendações),
 * geo-radar/ (monitoramento de queries/produtos), shared/ (tipos).
 */
@Module({
  controllers: [AiVisibilityController],
})
export class AiVisibilityModule {}
