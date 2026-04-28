import { Module } from '@nestjs/common'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { MessagingController } from './messaging.controller'
import { MessagingService } from './messaging.service'
import { TemplateRendererService } from './template-renderer.service'

@Module({
  imports:     [WhatsAppModule], // para WhatsAppSender + WhatsAppConfigService
  controllers: [MessagingController],
  providers:   [MessagingService, TemplateRendererService],
  exports:     [MessagingService, TemplateRendererService],
})
export class MessagingModule {}
