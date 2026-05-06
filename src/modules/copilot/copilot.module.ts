import { Module } from '@nestjs/common'
import { CopilotController } from './copilot.controller'
import { CopilotService } from './copilot.service'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [AiModule],
  controllers: [CopilotController],
  providers:   [CopilotService],
  exports:     [CopilotService],
})
export class CopilotModule {}
