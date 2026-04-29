import { Module } from '@nestjs/common'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { EmailSettingsModule } from '../email-settings/email-settings.module'
import { MessagingController } from './messaging.controller'
import { MessagingService } from './messaging.service'
import { TemplateRendererService } from './template-renderer.service'
import { EmailSenderService } from './email-sender.service'
import { JourneyEngineService } from './journey-engine.service'

@Module({
  imports:     [WhatsAppModule, EmailSettingsModule], // WA sender + EM-1 dispatcher
  controllers: [MessagingController],
  providers:   [MessagingService, TemplateRendererService, EmailSenderService, JourneyEngineService],
  exports:     [MessagingService, TemplateRendererService, JourneyEngineService],
})
export class MessagingModule {}
