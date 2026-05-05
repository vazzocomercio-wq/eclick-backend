import { Injectable, Logger } from '@nestjs/common'
import { ChannelRouterService } from './channel-router.service'
import { BaileysProvider } from '../channels/providers/baileys.provider'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import type { WaPurpose, SendResult } from './wa-router.types'

/**
 * Sender unificado pra qualquer texto WhatsApp do produto. Caller passa
 * apenas (orgId, purpose, to, body) — o router decide o backend.
 *
 * Backends suportados hoje:
 *   - Baileys (channels.id): WhatsApp Free não-oficial, baixo volume
 *   - Cloud API (whatsapp_config.id): Meta oficial OU Z-API (synthetic
 *     via env quando ZAPI_* setado)
 *
 * Erros são capturados e retornados como SendResult com error message —
 * caller decide retry/log.
 */
@Injectable()
export class UnifiedWhatsAppSender {
  private readonly logger = new Logger(UnifiedWhatsAppSender.name)

  constructor(
    private readonly router:   ChannelRouterService,
    private readonly baileys:  BaileysProvider,
    private readonly waConfig: WhatsAppConfigService,
    private readonly waSender: WhatsAppSender,
  ) {}

  async send(
    orgId:   string,
    purpose: WaPurpose,
    to:      string,
    body:    string,
  ): Promise<SendResult> {
    const route = await this.router.resolveChannel(orgId, purpose)
    if (!route) {
      return { success: false, error: `Sem canal WhatsApp disponível pra purpose=${purpose}` }
    }

    if (route.kind === 'baileys') {
      try {
        const r = await this.baileys.sendMessage(route.channelId, to, 'text', { body })
        return { success: true, channel: 'baileys', message_id: r.message_id }
      } catch (e) {
        const msg = (e as Error).message
        this.logger.warn(`[wa-router] org=${orgId} purpose=${purpose} via baileys falhou: ${msg}`)
        return { success: false, channel: 'baileys', error: msg }
      }
    }

    // route.kind === 'cloud_api'
    const cfg = await this.waConfig.findActive(orgId)
    if (!cfg) {
      return { success: false, channel: 'cloud_api', error: 'whatsapp_config não encontrado pra org' }
    }
    try {
      const r = await this.waSender.sendTextMessage({ phone: to, message: body, waConfig: cfg })
      return {
        success:    r.success,
        channel:    'cloud_api',
        ...(r.error ? { error: r.error } : {}),
      }
    } catch (e) {
      const msg = (e as Error).message
      this.logger.warn(`[wa-router] org=${orgId} purpose=${purpose} via cloud_api falhou: ${msg}`)
      return { success: false, channel: 'cloud_api', error: msg }
    }
  }
}
