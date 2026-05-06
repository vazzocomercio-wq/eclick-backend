import { Module } from '@nestjs/common'
import { CreativeController } from './creative.controller'
import { CreativeService } from './creative.service'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'
import { CreativeImagePipelineWorker } from './creative-image-pipeline.worker'
import { CreativeVideoPipelineService } from './creative-video-pipeline.service'
import { CreativeVideoPipelineWorker } from './creative-video-pipeline.worker'
import { CreativeMlPublisherService } from './creative-ml-publisher.service'
import { KlingClient } from './kling.client'
import { AiModule } from '../ai/ai.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'

@Module({
  imports:     [AiModule, MercadolivreModule],
  controllers: [CreativeController],
  providers:   [
    CreativeService,
    CreativeImagePipelineService,
    CreativeImagePipelineWorker,
    CreativeVideoPipelineService,
    CreativeVideoPipelineWorker,
    CreativeMlPublisherService,
    KlingClient,
  ],
  exports: [
    CreativeService,
    CreativeImagePipelineService,
    CreativeVideoPipelineService,
    CreativeMlPublisherService,
  ],
})
export class CreativeModule {}
