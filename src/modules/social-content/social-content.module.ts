import { Module } from '@nestjs/common'
import { SocialContentController } from './social-content.controller'
import { SocialContentService } from './social-content.service'
import { AiModule } from '../ai/ai.module'

/** Onda 3 / S1 — Social Content Generator. Gera posts/reels/stories/ads
 *  copy a partir de produtos enriquecidos do catálogo (Onda 1). */
@Module({
  imports:     [AiModule],
  controllers: [SocialContentController],
  providers:   [SocialContentService],
  exports:     [SocialContentService],
})
export class SocialContentModule {}
