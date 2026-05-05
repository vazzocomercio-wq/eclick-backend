import { Global, Module } from '@nestjs/common'
import { ChannelsModule } from '../channels/channels.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'
import { ChannelRouterService } from './channel-router.service'
import { UnifiedWhatsAppSender } from './unified-whatsapp-sender.service'
import { WaRouterController } from './wa-router.controller'

/**
 * @Global pra que qualquer service consumidor (IH delivery, messaging
 * engine, ads-ai alerter, etc) injete UnifiedWhatsAppSender sem precisar
 * importar WaRouterModule no seu próprio module.
 */
@Global()
@Module({
  imports:     [ChannelsModule, WhatsAppModule],
  controllers: [WaRouterController],
  providers:   [ChannelRouterService, UnifiedWhatsAppSender],
  exports:     [ChannelRouterService, UnifiedWhatsAppSender],
})
export class WaRouterModule {}
