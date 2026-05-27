import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { StoreBlogController, StoreBlogPublicController } from './store-blog.controller';
import { StoreBlogService } from './store-blog.service';
import { StoreBlogStudioService } from './store-blog-studio.service';
import { StoreBlogWorker } from './store-blog.worker';

/**
 * Blog da Loja (épico SB) — motor de conteúdo GEO da vitrine, ciente dos
 * produtos da loja. Reusa LlmService (texto + imagem) do AiModule.
 */
@Module({
  imports: [AiModule],
  controllers: [StoreBlogController, StoreBlogPublicController],
  providers: [StoreBlogService, StoreBlogStudioService, StoreBlogWorker],
  exports: [StoreBlogService],
})
export class StoreBlogModule {}
