import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { StoreBlogController } from './store-blog.controller';
import { StoreBlogService } from './store-blog.service';

/**
 * Blog da Loja (épico SB) — motor de conteúdo GEO da vitrine, ciente dos
 * produtos da loja. Reusa LlmService (texto + imagem) do AiModule.
 */
@Module({
  imports: [AiModule],
  controllers: [StoreBlogController],
  providers: [StoreBlogService],
  exports: [StoreBlogService],
})
export class StoreBlogModule {}
