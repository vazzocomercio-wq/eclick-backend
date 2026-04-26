import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import type { WhatsAppConfig } from './whatsapp-config.service'

const META_API = 'https://graph.facebook.com/v20.0'

@Injectable()
export class WhatsAppSender {
  private readonly logger = new Logger(WhatsAppSender.name)

  /**
   * Send a plain text message via WhatsApp Business Cloud API.
   * Returns success boolean + the wamid if Meta accepted it.
   * Never throws — failures are logged and surfaced via the return value
   * so the webhook caller can decide what to do (queue for retry, etc).
   */
  async sendTextMessage(input: {
    phone:     string
    message:   string
    waConfig:  WhatsAppConfig
  }): Promise<{ success: boolean; message_id?: string; error?: string }> {
    const { phone, message, waConfig } = input
    this.logger.log(`[wa.sender] enviando pra ${phone} via phone_number_id=${waConfig.phone_number_id}`)

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
      this.logger.log(`[wa.sender] resposta Meta: { wamid: ${messageId} }`)
      return { success: true, message_id: messageId }
    } catch (e: any) {
      const status = e?.response?.status ?? 0
      const errMsg = e?.response?.data?.error?.message ?? e?.message ?? 'erro desconhecido'
      this.logger.error(`[wa.sender] FALHOU status=${status} pra ${phone}: ${errMsg}`)
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
