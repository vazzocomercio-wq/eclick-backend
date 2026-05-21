import { Module } from '@nestjs/common'
import { AffiliatesAdminController, AffiliatesPublicController } from './affiliates.controller'
import { AffiliatesService } from './affiliates.service'
import { AffiliateAttributionService } from './affiliate-attribution.service'
import { AffiliatesCron } from './affiliates.cron'

@Module({
  controllers: [AffiliatesAdminController, AffiliatesPublicController],
  providers:   [AffiliatesService, AffiliateAttributionService, AffiliatesCron],
  exports:     [AffiliatesService, AffiliateAttributionService],
})
export class AffiliatesModule {}
