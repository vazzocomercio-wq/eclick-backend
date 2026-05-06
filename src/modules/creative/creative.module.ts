import { Module } from '@nestjs/common'
import { CreativeController } from './creative.controller'
import { CreativeService } from './creative.service'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'
import { CreativeImagePipelineWorker } from './creative-image-pipeline.worker'
import { CreativeVideoPipelineService } from './creative-video-pipeline.service'
import { CreativeVideoPipelineWorker } from './creative-video-pipeline.worker'
import { KlingClient } from './kling.client'
import { AiModule } from '../ai/ai.module'

@Module({
  imports:     [AiModule],
  controllers: [CreativeController],
  providers:   [
    CreativeService,
    CreativeImagePipelineService,
    CreativeImagePipelineWorker,
    CreativeVideoPipelineService,
    CreativeVideoPipelineWorker,
    KlingClient,
  ],
  exports: [
    CreativeService,
    CreativeImagePipelineService,
    CreativeVideoPipelineService,
  ],
})
export class CreativeModule {}
