import { Module } from '@nestjs/common'
import { WebhooksController } from './webhooks.controller'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { CustomersModule } from '../customers/customers.module'
import { AtendenteIaModule } from '../atendente-ia/atendente-ia.module'

@Module({
  imports:     [WhatsAppModule, CustomersModule, AtendenteIaModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
