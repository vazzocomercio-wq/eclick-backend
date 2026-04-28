import { Module } from '@nestjs/common'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { MessagingController } from './messaging.controller'
import { MessagingService } from './messaging.service'
import { TemplateRendererService } from './template-renderer.service'
import { JourneyEngineService } from './journey-engine.service'

@Module({
  imports:     [WhatsAppModule], // para WhatsAppSender + WhatsAppConfigService
  controllers: [MessagingController],
  providers:   [MessagingService, TemplateRendererService, JourneyEngineService],
  exports:     [MessagingService, TemplateRendererService],
})
export class MessagingModule {}
