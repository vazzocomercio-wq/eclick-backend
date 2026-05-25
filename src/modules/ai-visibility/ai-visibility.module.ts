import { Module } from '@nestjs/common'
import { AiVisibilityController } from './ai-visibility.controller'
import { GeoScoreModule } from './geo-score/geo-score.module'

/**
 * AI Visibility OS — GEO (Generative Engine Optimization).
 * Mede e melhora a presença dos produtos da org nos motores de IA.
 * Subpastas: geo-score/ (auditoria+nota), geo-optimizer/ (recomendações — Sprint 2),
 * geo-radar/ (monitoramento de queries/produtos — Sprint 3), shared/ (tipos).
 */
@Module({
  imports:     [GeoScoreModule],
  controllers: [AiVisibilityController],
})
export class AiVisibilityModule {}
