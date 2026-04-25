import { Module } from '@nestjs/common'
import { AiUsageService } from './ai-usage.service'
import { AiUsageController } from './ai-usage.controller'

@Module({
  controllers: [AiUsageController],
  providers: [AiUsageService],
  exports: [AiUsageService],
})
export class AiUsageModule {}
