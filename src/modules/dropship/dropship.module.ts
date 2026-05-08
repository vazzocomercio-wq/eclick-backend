import { Module } from '@nestjs/common'
import { DropshipController } from './dropship.controller'
import { DropshipPortalController } from './dropship-portal.controller'
import { DropshipService } from './dropship.service'
import { MessagingModule } from '../messaging/messaging.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'

@Module({
  imports: [MessagingModule, WhatsAppModule],
  controllers: [DropshipController, DropshipPortalController],
  providers: [DropshipService],
  exports: [DropshipService],
})
export class DropshipModule {}
