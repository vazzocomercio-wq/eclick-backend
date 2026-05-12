import { Module } from '@nestjs/common'
import { CreativeController } from './creative.controller'
import { CreativeService } from './creative.service'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'
import { CreativeImagePipelineWorker } from './creative-image-pipeline.worker'
import { CreativeVideoPipelineService } from './creative-video-pipeline.service'
import { CreativeVideoPipelineWorker } from './creative-video-pipeline.worker'
import { CreativeMlPublisherService } from './creative-ml-publisher.service'
import { CreativeMlSyncWorker } from './creative-ml-sync.worker'
import { CreativeCleanupWorker } from './creative-cleanup.worker'
import { CreativePromptTemplatesService } from './creative-prompt-templates.service'
import { CreativeReferencesService } from './creative-references.service'
import { CreativeTemplateResolutionService } from './creative-template-resolution.service'
import { CreativeTaxonomyService } from './creative-taxonomy.service'
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
    CreativeMlSyncWorker,
    CreativeCleanupWorker,
    // F6 Sprint 2 — Templates + References + Resolution + Taxonomy
    CreativePromptTemplatesService,
    CreativeReferencesService,
    CreativeTemplateResolutionService,
    CreativeTaxonomyService,
    KlingClient,
  ],
  exports: [
    CreativeService,
    CreativeImagePipelineService,
    CreativeVideoPipelineService,
    CreativeMlPublisherService,
    // F6 Sprint 2 — exposto pro pipeline (Fase 2.3 vai consumir)
    CreativePromptTemplatesService,
    CreativeReferencesService,
    CreativeTemplateResolutionService,
    CreativeTaxonomyService,
  ],
})
export class CreativeModule {}
