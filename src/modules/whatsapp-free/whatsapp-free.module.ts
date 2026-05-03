import { Module } from '@nestjs/common'
import { WhatsAppFreeController } from './whatsapp-free.controller'
import { WhatsAppFreeService } from './whatsapp-free.service'

@Module({
  controllers: [WhatsAppFreeController],
  providers:   [WhatsAppFreeService],
  exports:     [WhatsAppFreeService],
})
export class WhatsAppFreeModule {}
