import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Logger, Param, Post, Query, Res } from '@nestjs/common'
import type { Response } from 'express'
import { supabaseAdmin } from '../../common/supabase'
import { WhatsAppConfigService } from '../whatsapp/whatsapp-config.service'
import { WhatsAppAdapter } from '../whatsapp/whatsapp.adapter'
import { WhatsAppSender } from '../whatsapp/whatsapp.sender'
import { ConversationsService } from '../atendente-ia/conversations.service'
import { AiResponderService } from '../atendente-ia/ai-responder.service'
import { CustomerIdentityService } from '../customers/customer-identity.service'
import { ChatWidgetService } from '../widgets/chat-widget.service'

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
    private readonly widgets:      ChatWidgetService,
  ) {}

  // ── Meta webhook verification (one-time handshake) ───────────────────────

  @Get('whatsapp')
  async verifyWhatsApp(
    @Query('hub.mode')         mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge')    challenge: string,
    @Res()                     res: Response,
  ) {
    if (mode !== 'subscribe' || !token) return res.status(403).json({ error: 'Forbidden' })

    const config = await this.waConfig.findByVerifyToken(token)
    if (!config) return res.status(403).json({ error: 'Invalid verify_token' })

    await this.waConfig.update(config.id, { is_verified: true, last_verified_at: new Date().toISOString() })
    this.logger.log(`[wa.webhook] verificado config=${config.id}`)
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
        if (!messages.length) return

        const config = await this.waConfig.findActive()
        if (!config) {
          this.logger.error(`[wa.webhook] sem whatsapp_config ativa — não é possível responder`)
          return
        }

        for (const msg of messages) {
          // Mark as read immediately (best-effort)
          this.waSender.markAsRead(config, msg.external_id).catch(() => { /* logged inside */ })

          // Resolve unified customer
          const customer = await this.customers.resolveByWhatsAppId(msg.customer_whatsapp_id, msg.customer_name)
          if (!customer) continue

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

  // ── Widget (public — no auth, CORS open) ──────────────────────────────────

  @Post('widget/:token')
  @HttpCode(HttpStatus.OK)
  async receiveWidget(
    @Param('token') token: string,
    @Body() body: { message?: string; session_token?: string; name?: string; email?: string; phone?: string; origin_url?: string; user_agent?: string },
    @Res() res: Response,
  ) {
    // CORS: anyone can post (it's a public widget endpoint)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (!body?.message?.trim()) {
      return res.status(400).json({ error: 'message é obrigatório' })
    }

    try {
      const widget = await this.widgets.findByToken(token)
      if (!widget) return res.status(404).json({ error: 'Widget não encontrado' })

      // Find or create session
      let session = await this.widgets.getSession(body.session_token ?? '')
      if (!session) {
        session = await this.widgets.createSession(widget.id, {
          visitor_name:  body.name,
          visitor_email: body.email,
          visitor_phone: body.phone,
          origin_url:    body.origin_url,
          user_agent:    body.user_agent,
        })
      } else {
        await this.widgets.touchSession(session.id)
      }

      // Resolve customer if we have phone
      if (body.phone && !session.unified_customer_id) {
        const customer = await this.customers.resolveByPhone(body.phone, body.name, 'widget')
        if (customer) {
          await this.widgets.linkCustomerToSession(session.id, customer.id)
          session.unified_customer_id = customer.id
        }
      }

      // Find or create conversation
      let conversationId = session.conversation_id
      if (!conversationId) {
        const conv = await this.conversations.upsertConversation({
          channel:                  'widget',
          external_conversation_id: `widget:${session.session_token}`,
          external_customer_id:     session.unified_customer_id ?? session.session_token,
          customer_name:            session.visitor_name ?? body.name ?? 'Visitante',
        })
        conversationId = conv.id
        await this.widgets.linkConversationToSession(session.id, conv.id)

        if (session.unified_customer_id) {
          await supabaseAdmin
            .from('ai_conversations')
            .update({ unified_customer_id: session.unified_customer_id, customer_phone: body.phone, customer_email: body.email })
            .eq('id', conv.id)
        }
      }

      const result = await this.responder.processMessage({
        text:                body.message!,
        channel:             'widget',
        conversation_id:     conversationId,
        customer_name:       session.visitor_name ?? body.name,
        customer_phone:      body.phone,
        customer_email:      body.email,
        unified_customer_id: session.unified_customer_id ?? undefined,
        metadata:            { widget_id: widget.id, session_id: session.id },
      })

      // Send response to widget caller
      if (result.decision === 'auto_send' && result.response) {
        return res.status(200).json({
          message:         result.response,
          confidence:      result.confidence,
          session_token:   session.session_token,
          conversation_id: conversationId,
        })
      }
      return res.status(200).json({
        queued:          true,
        session_token:   session.session_token,
        conversation_id: conversationId,
      })
    } catch (err: any) {
      this.logger.error(`[widget.webhook] ERRO: ${err?.message}`, err?.stack)
      return res.status(500).json({ error: err?.message ?? 'erro' })
    }
  }
}
