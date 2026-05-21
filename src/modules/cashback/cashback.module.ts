import { Module } from '@nestjs/common'
import { CashbackController, CashbackPublicController } from './cashback.controller'
import { CashbackService } from './cashback.service'

@Module({
  controllers: [CashbackController, CashbackPublicController],
  providers:   [CashbackService],
  exports:     [CashbackService],
})
export class CashbackModule {}
