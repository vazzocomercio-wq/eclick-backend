import { Module } from '@nestjs/common'
import { PublicAuditsController } from './public-audits.controller'
import { PublicAuditsService } from './public-audits.service'
import { PublicAuditProcessorService } from './public-audit-processor.service'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { GeoScoreModule } from '../ai-visibility/geo-score/geo-score.module'
import { GeoOptimizerModule } from '../ai-visibility/geo-optimizer/geo-optimizer.module'

/**
 * AI Visibility OS — landing pública "Auditoria GEO Grátis".
 * Sprint 1: captura de lead + push pro funil "Captação GEO" do Active.
 * Sprint 2a: worker de análise GEO (reusa scraper/score/recs/rankSim do ai-visibility).
 */
@Module({
  imports:     [ActiveBridgeModule, GeoScoreModule, GeoOptimizerModule],
  controllers: [PublicAuditsController],
  providers:   [PublicAuditsService, PublicAuditProcessorService],
  exports:     [PublicAuditsService],
})
export class PublicAuditsModule {}
