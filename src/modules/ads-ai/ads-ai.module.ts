import { Module } from '@nestjs/common'
import { AdsAiController } from './ads-ai.controller'
import { AdsAiService } from './ads-ai.service'

@Module({
  controllers: [AdsAiController],
  providers:   [AdsAiService],
  exports:     [AdsAiService],
})
export class AdsAiModule {}
