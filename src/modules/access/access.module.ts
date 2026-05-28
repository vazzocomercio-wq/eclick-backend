import { Module } from '@nestjs/common'
import { AccessService } from './access.service'
import { StripePlatformService } from './stripe-platform.service'
import { AccessPublicController, AccessAdminController } from './access.controller'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'

@Module({
  imports:     [WhatsAppModule],
  controllers: [AccessPublicController, AccessAdminController],
  providers:   [AccessService, StripePlatformService],
  exports:     [AccessService, StripePlatformService],
})
export class AccessModule {}
