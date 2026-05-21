import { Module } from '@nestjs/common'
import { BonusController, BonusPublicController } from './bonus.controller'
import { BonusService } from './bonus.service'

@Module({
  controllers: [BonusController, BonusPublicController],
  providers:   [BonusService],
  exports:     [BonusService],
})
export class BonusModule {}
