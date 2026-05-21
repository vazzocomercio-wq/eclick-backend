import { Module } from '@nestjs/common'
import { LoyaltyController, LoyaltyPublicController } from './loyalty.controller'
import { LoyaltyService } from './loyalty.service'

@Module({
  controllers: [LoyaltyController, LoyaltyPublicController],
  providers:   [LoyaltyService],
  exports:     [LoyaltyService],
})
export class LoyaltyModule {}
