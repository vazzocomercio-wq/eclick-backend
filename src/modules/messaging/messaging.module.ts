import { Module } from '@nestjs/common'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { MessagingController } from './messaging.controller'
import { MessagingService } from './messaging.service'
import { TemplateRendererService } from './template-renderer.service'
import { EmailSenderService } from './email-sender.service'
import { JourneyEngineService } from './journey-engine.service'

@Module({
  imports:     [WhatsAppModule], // para WhatsAppSender + WhatsAppConfigService
  controllers: [MessagingController],
  providers:   [MessagingService, TemplateRendererService, EmailSenderService, JourneyEngineService],
  exports:     [MessagingService, TemplateRendererService, JourneyEngineService],
})
export class MessagingModule {}
