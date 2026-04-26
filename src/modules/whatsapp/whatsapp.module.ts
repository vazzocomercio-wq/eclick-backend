import { Module } from '@nestjs/common'
import { WhatsAppController } from './whatsapp.controller'
import { WhatsAppConfigService } from './whatsapp-config.service'
import { WhatsAppAdapter } from './whatsapp.adapter'
import { WhatsAppSender } from './whatsapp.sender'

@Module({
  controllers: [WhatsAppController],
  providers:   [WhatsAppConfigService, WhatsAppAdapter, WhatsAppSender],
  exports:     [WhatsAppConfigService, WhatsAppAdapter, WhatsAppSender],
})
export class WhatsAppModule {}
