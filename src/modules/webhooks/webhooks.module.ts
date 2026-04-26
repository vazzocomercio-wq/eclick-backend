import { Module } from '@nestjs/common'
import { WebhooksController } from './webhooks.controller'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { CustomersModule } from '../customers/customers.module'
import { AtendenteIaModule } from '../atendente-ia/atendente-ia.module'
import { WidgetsModule } from '../widgets/widgets.module'

@Module({
  imports:     [WhatsAppModule, CustomersModule, AtendenteIaModule, WidgetsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
