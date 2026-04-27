import { Module } from '@nestjs/common'
import { AdsAiController } from './ads-ai.controller'
import { AdsAiService } from './ads-ai.service'
import { ContextBuilderService } from './services/context-builder.service'
import { InsightDetectorService } from './services/insight-detector.service'

@Module({
  controllers: [AdsAiController],
  providers:   [AdsAiService, ContextBuilderService, InsightDetectorService],
  exports:     [AdsAiService, ContextBuilderService, InsightDetectorService],
})
export class AdsAiModule {}
