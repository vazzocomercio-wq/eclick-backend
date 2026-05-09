import { Module } from '@nestjs/common'
import { DropshipController } from './dropship.controller'
import { DropshipPortalController, DropshipWebhooksController } from './dropship-portal.controller'
import { DropshipService } from './dropship.service'
import { MessagingModule } from '../messaging/messaging.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { FinanceiroModule } from '../financeiro/financeiro.module'
import { AiModule } from '../ai/ai.module'

@Module({
  imports: [MessagingModule, WhatsAppModule, FinanceiroModule, AiModule],
  controllers: [DropshipController, DropshipPortalController, DropshipWebhooksController],
  providers: [DropshipService],
  exports: [DropshipService],
})
export class DropshipModule {}
