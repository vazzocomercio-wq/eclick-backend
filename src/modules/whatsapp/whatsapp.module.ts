import { Module } from '@nestjs/common'
import { WhatsAppController } from './whatsapp.controller'
import { WhatsAppOpsController } from './whatsapp-ops.controller'
import { WhatsAppConfigService } from './whatsapp-config.service'
import { WhatsAppAdapter } from './whatsapp.adapter'
import { WhatsAppSender } from './whatsapp.sender'
import { ZapiProvider } from './zapi.provider'

@Module({
  controllers: [WhatsAppController, WhatsAppOpsController],
  providers:   [WhatsAppConfigService, WhatsAppAdapter, WhatsAppSender, ZapiProvider],
  exports:     [WhatsAppConfigService, WhatsAppAdapter, WhatsAppSender, ZapiProvider],
})
export class WhatsAppModule {}
