import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import type { WhatsAppConfig } from './whatsapp-config.service'
import { ZapiProvider } from './zapi.provider'

const META_API = 'https://graph.facebook.com/v20.0'

/** Fachada de envio de WhatsApp. Roteia entre Z-API (default quando env
 * vars setadas) e Meta Cloud API legado (waConfig do banco). Callers não
 * precisam saber qual provider está ativo — basta passar phone+message
 * e opcionalmente waConfig pra fallback Meta. */
@Injectable()
export class WhatsAppSender {
  private readonly logger = new Logger(WhatsAppSender.name)

  constructor(private readonly zapi: ZapiProvider) {}

  /** Envia texto. Z-API tem prioridade quando configurado por env;
   * caso contrário cai pro Meta Cloud usando waConfig do banco. Nunca
   * lança — o caller decide o que fazer com {success:false}. */
  async sendTextMessage(input: {
    phone:     string
    message:   string
    waConfig?: WhatsAppConfig
  }): Promise<{ success: boolean; message_id?: string; error?: string }> {
    const { phone, message, waConfig } = input

    if (this.zapi.isConfigured()) {
      const r = await this.zapi.sendText(phone, message)
      return { success: r.success, message_id: r.zapiMessageId, error: r.error }
    }

    if (!waConfig?.access_token) {
      return { success: false, error: 'WhatsApp não configurado (sem ZAPI env nem Meta cfg)' }
    }

    try {
      const { data } = await axios.post(
        `${META_API}/${waConfig.phone_number_id}/messages`,
        {
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: message, preview_url: false },
        },
        {
          headers: {
            Authorization:  `Bearer ${waConfig.access_token}`,
            'Content-Type': 'application/json',
          },
        },
      )
      const messageId = data?.messages?.[0]?.id
      return { success: true, message_id: messageId }
    } catch (e: any) {
      const status = e?.response?.status ?? 0
      const errMsg = e?.response?.data?.error?.message ?? e?.message ?? 'erro desconhecido'
      this.logger.error(`[wa.sender] meta FALHOU status=${status} pra ${phone}: ${errMsg}`)
      return { success: false, error: errMsg }
    }
  }

  /** Mark an inbound message as read (blue double-checks). Best-effort. */
  async markAsRead(waConfig: WhatsAppConfig, wamid: string): Promise<void> {
    try {
      await axios.post(
        `${META_API}/${waConfig.phone_number_id}/messages`,
        {
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: wamid,
        },
        { headers: { Authorization: `Bearer ${waConfig.access_token}`, 'Content-Type': 'application/json' } },
      )
    } catch (e: any) {
      this.logger.warn(`[wa.sender] markAsRead falhou ${wamid}: ${e?.response?.data?.error?.message ?? e?.message}`)
    }
  }
}
