import { Module } from '@nestjs/common'
import { AiVisibilityController } from './ai-visibility.controller'
import { GeoScoreModule } from './geo-score/geo-score.module'
import { GeoOptimizerModule } from './geo-optimizer/geo-optimizer.module'

/**
 * AI Visibility OS — GEO (Generative Engine Optimization).
 * Mede e melhora a presença dos produtos da org nos motores de IA.
 * Subpastas: geo-score/ (auditoria+nota), geo-optimizer/ (reescrita título/desc — Sprint 2),
 * geo-radar/ (monitoramento de queries/produtos — Sprint 3), shared/ (tipos).
 */
@Module({
  imports:     [GeoScoreModule, GeoOptimizerModule],
  controllers: [AiVisibilityController],
})
export class AiVisibilityModule {}
