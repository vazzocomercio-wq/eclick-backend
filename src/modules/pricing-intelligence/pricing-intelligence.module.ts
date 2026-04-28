import { Module } from '@nestjs/common'
import { PricingConfigController } from './pricing-config.controller'
import { PricingConfigService } from './pricing-config.service'
import { PricingPresetsService } from './pricing-presets.service'
import { PricingAuditService } from './pricing-audit.service'

@Module({
  controllers: [PricingConfigController],
  providers:   [PricingConfigService, PricingPresetsService, PricingAuditService],
  exports:     [PricingConfigService, PricingPresetsService, PricingAuditService],
})
export class PricingIntelligenceModule {}
