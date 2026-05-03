import { Module } from '@nestjs/common'
import { ChannelsController } from './channels.controller'
import { ChannelsService } from './channels.service'
import { BaileysProvider } from './providers/baileys.provider'

/**
 * Canais de comunicação por organização (whatsapp, whatsapp_free, email,
 * instagram, tiktok). NÃO confundir com MarketplaceChannelsModule (catálogo
 * de marketplaces como ML/Shopee).
 *
 * Bug #1 Active: TODOS os providers DEVEM estar registrados aqui — esquecer
 * algum quebra DI silenciosamente em runtime.
 */
@Module({
  controllers: [ChannelsController],
  providers:   [ChannelsService, BaileysProvider],
  exports:     [ChannelsService, BaileysProvider],
})
export class ChannelsModule {}
