import { Module } from '@nestjs/common'
import { CreativeController } from './creative.controller'
import { CreativeService } from './creative.service'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [AiModule],
  controllers: [CreativeController],
  providers:   [CreativeService],
  exports:     [CreativeService],
})
export class CreativeModule {}
