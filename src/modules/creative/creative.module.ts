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
import { CreativeSeoService } from './creative-seo.service'
import { KlingClient } from './kling.client'
import { KlingProvider } from './providers/kling.provider'
import { FlowProvider } from './providers/flow.provider'
import { SoraProvider } from './providers/sora.provider'
import { VideoProviderRegistry } from './providers/video-provider.registry'
import { AiModule } from '../ai/ai.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { CredentialsModule } from '../credentials/credentials.module'
import { EOtimizerModule } from '../e-otimizer/e-otimizer.module'

@Module({
  imports:     [AiModule, MercadolivreModule, CredentialsModule, EOtimizerModule],
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
    CreativeSeoService,
    KlingClient,
    // F6 — abstração multi-provider de vídeo (Kling + Veo/Flow + Sora 2)
    KlingProvider,
    FlowProvider,
    SoraProvider,
    VideoProviderRegistry,
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
    CreativeSeoService,
  ],
})
export class CreativeModule {}
