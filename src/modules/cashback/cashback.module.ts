import { Module } from '@nestjs/common'
import { CashbackController, CashbackPublicController } from './cashback.controller'
import { CashbackService } from './cashback.service'
import { CashbackCron } from './cashback.cron'

@Module({
  controllers: [CashbackController, CashbackPublicController],
  providers:   [CashbackService, CashbackCron],
  exports:     [CashbackService],
})
export class CashbackModule {}
