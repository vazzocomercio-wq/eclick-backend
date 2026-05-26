import { Module } from '@nestjs/common'
import { PublicAuditsController } from './public-audits.controller'
import { PublicAuditsService } from './public-audits.service'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

/**
 * AI Visibility OS — landing pública "Auditoria GEO Grátis".
 * Sprint 1: captura de lead + push pro funil "Captação GEO" do Active.
 * Sprint 2 (a fazer): worker de análise GEO + telas loading/resultado + nutrição.
 */
@Module({
  imports:     [ActiveBridgeModule],
  controllers: [PublicAuditsController],
  providers:   [PublicAuditsService],
  exports:     [PublicAuditsService],
})
export class PublicAuditsModule {}
