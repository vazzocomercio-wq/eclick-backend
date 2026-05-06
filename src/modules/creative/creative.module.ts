import { Module } from '@nestjs/common'
import { CreativeController } from './creative.controller'
import { CreativeService } from './creative.service'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'
import { CreativeImagePipelineWorker } from './creative-image-pipeline.worker'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [AiModule],
  controllers: [CreativeController],
  providers:   [CreativeService, CreativeImagePipelineService, CreativeImagePipelineWorker],
  exports:     [CreativeService, CreativeImagePipelineService],
})
export class CreativeModule {}
