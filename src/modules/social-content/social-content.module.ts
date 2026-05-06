import { Module } from '@nestjs/common'
import { SocialContentController } from './social-content.controller'
import { SocialContentService } from './social-content.service'
import { SocialContentWorker } from './social-content.worker'
import { AiModule } from '../ai/ai.module'
import { ActiveBridgeModule } from '../active-bridge/active-bridge.module'

/** Onda 3 / S1 — Social Content Generator. Gera posts/reels/stories/ads
 *  copy a partir de produtos enriquecidos do catálogo (Onda 1).
 *
 *  Publish-now (whatsapp_broadcast) usa ActiveBridgeClient pra disparar
 *  via Active. Worker fica de olho em scheduled cujo scheduled_at venceu. */
@Module({
  imports:     [AiModule, ActiveBridgeModule],
  controllers: [SocialContentController],
  providers:   [SocialContentService, SocialContentWorker],
  exports:     [SocialContentService],
})
export class SocialContentModule {}
