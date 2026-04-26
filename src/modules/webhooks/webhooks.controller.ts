import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { supabaseAdmin } from '../../common/supabase'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import { WhatsAppAdapter } from '../whatsapp/whatsapp.adapter'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { ConversationsService } from '../atendente-ia/conversations.service'
import { AiResponderService } from '../atendente-ia/ai-responder.service'
import { CustomerIdentityService } from '../customers/customer-identity.service'

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name)

  constructor(
    private readonly waConfig:     WhatsAppConfigService,
    private readonly waAdapter:    WhatsAppAdapter,
    private readonly waSender:     WhatsAppSender,
    private readonly conversations: ConversationsService,
    private readonly responder:    AiResponderService,
    private readonly customers:    CustomerIdentityService,
  ) {}

  // ── Meta webhook verification (one-time handshake) ───────────────────────

  @Get('whatsapp')
  async verifyWhatsApp(
    @Query('hub.mode')         mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge')    challenge: string,
    @Res()                     res: Response,
  ) {
    this.logger.log(`[wa.webhook] verify mode=${mode} token=${token?.slice(0, 8)}…`)
    if (mode !== 'subscribe' || !token) return res.status(403).json({ error: 'Forbidden' })

    const config = await this.waConfig.findByVerifyToken(token)
    if (!config) {
      this.logger.warn(`[wa.webhook] verify_token desconhecido`)
      return res.status(403).json({ error: 'Invalid verify_token' })
    }

    await this.waConfig.update(config.id, { is_verified: true, last_verified_at: new Date().toISOString() })
    this.logger.log(`[wa.webhook] verificado com sucesso config=${config.id}`)
    return res.status(200).send(challenge)
  }

  // ── Receive WhatsApp messages ─────────────────────────────────────────────
  // CRITICAL: Meta requires a 200 response within 5s. We respond immediately
  // and process via setImmediate so slow LLM/DB calls don't block.

  @Post('whatsapp')
  @HttpCode(HttpStatus.OK)
  async receiveWhatsApp(@Body() body: unknown, @Res() res: Response) {
    res.status(200).json({ status: 'ok' })

    setImmediate(async () => {
      try {
        // Audit log
        await supabaseAdmin.from('webhook_events').insert({
          channel: 'whatsapp', event_type: 'message', payload: body as object,
        })

        const messages = this.waAdapter.normalizeWebhook(body)
        if (!messages.length) {
          this.logger.log(`[wa.webhook] payload sem mensagens de texto — ignorado`)
          return
        }

        const config = await this.waConfig.findActive()
        if (!config) {
          this.logger.error(`[wa.webhook] sem whatsapp_config ativa — não é possível responder`)
          return
        }

        for (const msg of messages) {
          this.logger.log(`[wa.webhook] mensagem recebida de +${msg.customer_phone}: "${msg.text.slice(0, 60)}"`)

          // Mark as read immediately (best-effort)
          this.waSender.markAsRead(config, msg.external_id).catch(() => { /* logged inside */ })

          // Resolve unified customer
          const customer = await this.customers.resolveByWhatsAppId(msg.customer_whatsapp_id, msg.customer_name)
          if (!customer) {
            this.logger.warn(`[wa.webhook] não consegui resolver cliente — pulando`)
            continue
          }

          // Find or create conversation
          const conv = await this.conversations.upsertConversation({
            channel:                  'whatsapp',
            external_conversation_id: msg.customer_whatsapp_id, // 1 conv por número
            external_customer_id:     msg.customer_whatsapp_id,
            customer_name:            msg.customer_name,
            customer_nickname:        msg.customer_name,
          })

          // Patch the conversation with cross-channel identity (these columns
          // came in with the wave-2 migration — old rows won't have them)
          await supabaseAdmin
            .from('ai_conversations')
            .update({
              unified_customer_id:  customer.id,
              customer_phone:       msg.customer_phone,
              customer_whatsapp_id: msg.customer_whatsapp_id,
            })
            .eq('id', conv.id)

          // Process via AI engine
          const result = await this.responder.processMessage({
            text:                 msg.text,
            channel:              'whatsapp',
            conversation_id:      conv.id,
            customer_name:        customer.display_name ?? msg.customer_name,
            customer_phone:       msg.customer_phone,
            customer_whatsapp_id: msg.customer_whatsapp_id,
            unified_customer_id:  customer.id,
            metadata:             { wamid: msg.external_id, wa_config_id: config.id },
          })

          // Send response if auto
          if (result.decision === 'auto_send' && result.response) {
            const send = await this.waSender.sendTextMessage({
              phone:    msg.customer_phone,
              message:  result.response,
              waConfig: config,
            })
            if (send.success && send.message_id && result.ai_message_id) {
              // Stamp the wamid on the ai_messages row for traceability
              await supabaseAdmin
                .from('ai_messages')
                .update({ external_message_id: send.message_id })
                .eq('id', result.ai_message_id)
            }
          }

          this.logger.log(`[wa.webhook] processado: ${msg.customer_name} → ${result.decision} (${result.confidence}%)`)
        }
      } catch (err: any) {
        this.logger.error(`[wa.webhook] ERRO: ${err?.message}`, err?.stack)
        try {
          await supabaseAdmin.from('webhook_events').insert({
            channel: 'whatsapp', event_type: 'error', payload: body as object, error: err?.message ?? 'unknown', processed: false,
          })
        } catch { /* don't double-fail */ }
      }
    })
  }
}
