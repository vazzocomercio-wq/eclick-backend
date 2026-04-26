import { Injectable, Logger } from '@nestjs/common'

export interface InternalWhatsAppMessage {
  text: string
  channel: 'whatsapp'
  external_id: string           // wamid.xxx
  customer_phone: string        // 5511999999999
  customer_name: string
  customer_whatsapp_id: string
  timestamp: number
  media_url?: string
  media_type?: string
}

@Injectable()
export class WhatsAppAdapter {
  private readonly logger = new Logger(WhatsAppAdapter.name)

  /**
   * Normalize the Meta webhook payload into a flat array of internal
   * messages. Drops non-text messages with a log line (media/template
   * support is future work). Robust to missing fields.
   */
  normalizeWebhook(payload: unknown): InternalWhatsAppMessage[] {
    const result: InternalWhatsAppMessage[] = []
    const meta = payload as { entry?: Array<{ changes?: Array<{ value?: WaValue }> }> }

    for (const entry of meta?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value?.messages?.length) continue

        const contacts = value.contacts ?? []
        const nameByWaId = new Map<string, string>()
        for (const c of contacts) {
          if (c.wa_id) nameByWaId.set(c.wa_id, c.profile?.name ?? '')
        }

        for (const m of value.messages) {
          if (m.type !== 'text' || !m.text?.body) continue
          const waId = m.from
          result.push({
            text:                 m.text.body,
            channel:              'whatsapp',
            external_id:          m.id,
            customer_phone:       waId,
            customer_whatsapp_id: waId,
            customer_name:        nameByWaId.get(waId) || waId,
            timestamp:            Number(m.timestamp ?? Date.now() / 1000),
          })
        }
      }
    }
    return result
  }
}

// ── Meta webhook shape (subset of what we use) ────────────────────────────

interface WaContact {
  wa_id?: string
  profile?: { name?: string }
}

interface WaMessage {
  id: string
  from: string                  // wa_id of sender (= phone number)
  timestamp?: string | number
  type: string
  text?: { body: string }
}

interface WaValue {
  messaging_product?: string
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: WaContact[]
  messages?: WaMessage[]
}
