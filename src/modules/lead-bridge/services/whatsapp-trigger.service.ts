import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { UnifiedWhatsAppSender } from '../../wa-router/unified-whatsapp-sender.service'
import { LeadBridgeService } from '../lead-bridge.service'

@Injectable()
export class WhatsAppTriggerService {
  private readonly logger = new Logger(WhatsAppTriggerService.name)

  constructor(
    private readonly unifiedWa: UnifiedWhatsAppSender,
    private readonly leadBridge: LeadBridgeService,
  ) {}

  /** Render a {{template}} string against the conversion row. Unknown
   * placeholders fall back to empty strings so the message still sends. */
  renderTemplate(template: string, ctx: Record<string, string | null | undefined>): string {
    return template.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, k) => String(ctx[k] ?? ''))
  }

  /** Sends a single WhatsApp message tied to a conversion + bumps the
   * journey_messages_sent counter. Never throws. */
  async sendForConversion(conversionId: string, message: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data: conv } = await supabaseAdmin
        .from('lead_bridge_conversions')
        .select('id, organization_id, full_name, phone, whatsapp, consent_whatsapp, journey_messages_sent')
        .eq('id', conversionId)
        .maybeSingle()
      if (!conv || !conv.consent_whatsapp) return { success: false, error: 'sem consentimento' }
      const phone = (conv.whatsapp ?? conv.phone ?? '') as string
      const digits = phone.replace(/\D/g, '')
      if (!digits) return { success: false, error: 'sem telefone' }

      const rendered = this.renderTemplate(message, {
        nome: conv.full_name as string | null,
        first_name: ((conv.full_name as string | null) ?? '').split(' ')[0],
      })

      // Routing por purpose='customer_journey' — Baileys/Cloud auto
      const send = await this.unifiedWa.send(
        conv.organization_id as string,
        'customer_journey',
        digits,
        rendered,
      )
      if (!send.success) return { success: false, error: send.error }

      await supabaseAdmin
        .from('lead_bridge_conversions')
        .update({ journey_messages_sent: ((conv.journey_messages_sent as number | null) ?? 0) + 1 })
        .eq('id', conversionId)
      return { success: true }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[lb.wa.send] ${conversionId}: ${err?.message}`)
      return { success: false, error: err?.message }
    }
  }

  /** Welcome message right after conversion. Looks up the org's template;
   * falls back to a generic copy if none configured. */
  async sendWelcome(conversionId: string): Promise<void> {
    try {
      const { data: conv } = await supabaseAdmin
        .from('lead_bridge_conversions')
        .select('id, organization_id, channel, consent_whatsapp')
        .eq('id', conversionId)
        .maybeSingle()
      if (!conv || !conv.consent_whatsapp) return
      const config = await this.leadBridge.getConfig(conv.organization_id as string)
      if (!config.whatsapp_auto_message_enabled) return

      const template = config.whatsapp_welcome_template
        ?? 'Olá {{first_name}}! Recebemos seus dados e vamos manter você atualizado por aqui. ✨'
      await this.sendForConversion(conversionId, template)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[lb.wa.welcome] ${conversionId}: ${err?.message}`)
    }
  }

  /** Picks the active journey for this channel and creates a journey_run
   * starting at step 0 (which the cron will fire on its next tick). */
  async startJourneyRun(conversionId: string, channel: string): Promise<void> {
    try {
      const { data: conv } = await supabaseAdmin
        .from('lead_bridge_conversions')
        .select('organization_id')
        .eq('id', conversionId)
        .maybeSingle()
      if (!conv) return

      const { data: journey } = await supabaseAdmin
        .from('lead_bridge_journeys')
        .select('id, steps')
        .eq('organization_id', conv.organization_id as string)
        .eq('is_active', true)
        .or(`trigger_channel.eq.${channel},trigger_channel.is.null`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!journey) return

      await supabaseAdmin.from('lead_bridge_journey_runs').insert({
        conversion_id: conversionId,
        journey_id:    journey.id,
        current_step:  0,
        next_step_at:  new Date().toISOString(),
        status:        'active',
      })
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[lb.journey.start] ${conversionId}: ${err?.message}`)
    }
  }
}
