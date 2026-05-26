import { Module } from '@nestjs/common'
import { PublicAuditsController } from './public-audits.controller'
import { PublicAuditsService } from './public-audits.service'
import { PublicAuditProcessorService } from './public-audit-processor.service'
import { PublicAuditNurtureService } from './public-audit-nurture.service'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'
import { GeoScoreModule } from '../ai-visibility/geo-score/geo-score.module'
import { GeoOptimizerModule } from '../ai-visibility/geo-optimizer/geo-optimizer.module'
import { MessagingModule } from '../messaging/messaging.module'

/**
 * AI Visibility OS — landing pública "Auditoria GEO Grátis".
 * Sprint 1: captura de lead + push pro funil "Captação GEO" do Active.
 * Sprint 2a: worker de análise GEO (reusa scraper/score/rankSim do ai-visibility).
 * Sprint 2c: nutrição email+WhatsApp (EmailSender via MessagingModule).
 */
@Module({
  imports:     [ActiveBridgeModule, GeoScoreModule, GeoOptimizerModule, MessagingModule],
  controllers: [PublicAuditsController],
  providers:   [PublicAuditsService, PublicAuditProcessorService, PublicAuditNurtureService],
  exports:     [PublicAuditsService],
})
export class PublicAuditsModule {}
