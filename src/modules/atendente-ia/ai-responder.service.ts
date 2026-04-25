import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { ConversationsService } from './conversations.service'

interface MlQuestion {
  id: number
  item_id: string
  text: string
  date_created: string
  from?: { nickname: string; id: number }
  item?: { title: string; price: number; thumbnail: string }
}

@Injectable()
export class AiResponderService {
  private readonly logger = new Logger(AiResponderService.name)

  constructor(private readonly conversations: ConversationsService) {}

  // ── ML Question polling ────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async pollMlQuestions() {
    try {
      const { data: connections } = await supabaseAdmin
        .from('ml_connections')
        .select('organization_id, access_token, seller_id, expires_at')

      if (!connections?.length) return

      for (const conn of connections) {
        if (new Date(conn.expires_at) < new Date()) continue

        const { data: agentChannel } = await supabaseAdmin
          .from('ai_agent_channels')
          .select('*, agent:ai_agents(*)')
          .eq('channel', 'ml')
          .eq('is_active', true)
          .limit(1)
          .maybeSingle()

        if (!agentChannel) continue

        await this.processOrgMlQuestions(
          conn.organization_id,
          conn.access_token,
          conn.seller_id,
          agentChannel,
        )
      }
    } catch (err) {
      this.logger.error('[pollMlQuestions]', err)
    }
  }

  private async processOrgMlQuestions(
    orgId: string,
    token: string,
    sellerId: number,
    agentChannel: { agent: { id: string; name: string; model_provider: string; model_id: string; system_prompt: string; tone: string; language: string }; mode: string; confidence_threshold: number; max_response_length: number; escalate_keywords: string[]; auto_reply_delay_seconds: number },
  ) {
    try {
      const res = await axios.get(
        `https://api.mercadolibre.com/questions/search?seller_id=${sellerId}&status=UNANSWERED&limit=20`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      const questions: MlQuestion[] = res.data?.questions ?? []

      for (const q of questions) {
        const existing = await supabaseAdmin
          .from('ai_conversations')
          .select('id, status')
          .eq('channel', 'ml')
          .eq('external_conversation_id', String(q.id))
          .maybeSingle()

        if (existing.data?.status === 'resolved') continue

        await this.processIncomingMessage({
          orgId,
          mlToken: token,
          channel: 'ml',
          externalConvId: String(q.id),
          customerMessage: q.text,
          customerInfo: { nickname: q.from?.nickname ?? 'Comprador', id: q.from?.id },
          productInfo: {
            id: q.item_id,
            title: q.item?.title ?? '',
            price: q.item?.price ?? 0,
            thumbnail: q.item?.thumbnail ?? '',
          },
          agentChannel,
        })
      }
    } catch (err) {
      this.logger.warn('[processOrgMlQuestions]', (err as Error).message)
    }
  }

  // ── Core processor ────────────────────────────────────────────────────────

  async processIncomingMessage(opts: {
    orgId: string
    mlToken?: string
    channel: string
    externalConvId: string
    customerMessage: string
    customerInfo: { nickname?: string; id?: number }
    productInfo: { id?: string; title?: string; price?: number; thumbnail?: string }
    agentChannel: {
      agent: {
        id: string; name: string; model_provider: string; model_id: string
        system_prompt: string; tone: string; language: string
      }
      mode: string
      confidence_threshold: number
      max_response_length: number
      escalate_keywords: string[]
      auto_reply_delay_seconds: number
    }
  }) {
    const { agentChannel, channel, externalConvId, customerMessage, customerInfo, productInfo } = opts

    // 1. Upsert conversation
    const conv = await this.conversations.upsertConversation({
      agent_id: agentChannel.agent.id,
      channel,
      external_conversation_id: externalConvId,
      external_customer_id: String(customerInfo.id ?? ''),
      customer_name: customerInfo.nickname,
      customer_nickname: customerInfo.nickname,
      listing_id: productInfo.id,
      listing_title: productInfo.title,
    })

    // 2. Save customer message
    const existing = await this.conversations.getMessages(conv.id)
    const alreadySaved = existing.some(m => m.content === customerMessage && m.role === 'customer')
    if (!alreadySaved) {
      await this.conversations.addMessage({
        conversation_id: conv.id,
        role: 'customer',
        content: customerMessage,
        external_message_id: externalConvId,
      })
    }

    // 3. Check escalation keywords
    const lowerMsg = customerMessage.toLowerCase()
    const shouldEscalate = (agentChannel.escalate_keywords ?? []).some(kw =>
      lowerMsg.includes(kw.toLowerCase())
    )

    if (shouldEscalate) {
      await this.conversations.escalate(conv.id)
      return
    }

    // 4. If human-only mode, just queue for human
    if (agentChannel.mode === 'human') {
      await supabaseAdmin
        .from('ai_conversations')
        .update({ status: 'waiting_human', updated_at: new Date().toISOString() })
        .eq('id', conv.id)
      return
    }

    // 5. Fetch knowledge + recent messages for context
    const [knowledgeRes, messagesRes] = await Promise.all([
      supabaseAdmin
        .from('ai_knowledge_base')
        .select('title, content')
        .eq('agent_id', agentChannel.agent.id)
        .eq('is_active', true)
        .limit(10),
      supabaseAdmin
        .from('ai_messages')
        .select('role, content')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: false })
        .limit(10),
    ])

    const knowledge = knowledgeRes.data ?? []
    const recentMessages = (messagesRes.data ?? []).reverse()

    // 6. Build context and call AI
    const contextPrompt = this.buildContext(
      agentChannel.agent,
      customerMessage,
      recentMessages,
      knowledge,
      productInfo,
      agentChannel.max_response_length,
    )

    const aiResponse = await this.callAI(
      agentChannel.agent.model_provider,
      agentChannel.agent.model_id,
      contextPrompt,
    )

    if (!aiResponse) return

    // 7. Estimate confidence (simple heuristic based on response length)
    const confidence = this.estimateConfidence(aiResponse, customerMessage)

    const autoSend = agentChannel.mode === 'auto' ||
      (agentChannel.mode === 'hybrid' && confidence >= agentChannel.confidence_threshold)

    // 8. Save AI message
    await this.conversations.addMessage({
      conversation_id: conv.id,
      role: 'agent',
      content: aiResponse,
      ai_provider: agentChannel.agent.model_provider,
      ai_model: agentChannel.agent.model_id,
      ai_confidence: confidence,
      was_auto_sent: autoSend,
    })

    // 9. If auto-send and ML channel, reply via API
    if (autoSend && channel === 'ml' && opts.mlToken) {
      if (agentChannel.auto_reply_delay_seconds > 0) {
        await new Promise(r => setTimeout(r, agentChannel.auto_reply_delay_seconds * 1000))
      }
      await this.sendMlAnswer(opts.mlToken, Number(externalConvId), aiResponse)
    }

    // 10. Update analytics
    await this.updateAnalytics(agentChannel.agent.id, channel, autoSend)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildContext(
    agent: { name: string; tone: string; language: string; system_prompt: string },
    customerMessage: string,
    history: Array<{ role: string; content: string }>,
    knowledge: Array<{ title: string; content: string }>,
    product: { title?: string; price?: number },
    maxLength: number,
  ): string {
    const historyText = history.length
      ? history.map(m => `${m.role === 'customer' ? 'Cliente' : 'Agente'}: ${m.content}`).join('\n')
      : 'Início da conversa'

    const knowledgeText = knowledge.length
      ? knowledge.map(k => `• ${k.title}: ${k.content}`).join('\n')
      : 'Nenhuma informação específica disponível'

    return `${agent.system_prompt || `Você é ${agent.name}, atendente virtual de e-commerce. Responda de forma ${agent.tone} e precisa.`}

PRODUTO:
${product.title || 'Não especificado'}${product.price ? ` - R$ ${product.price}` : ''}

HISTÓRICO RECENTE:
${historyText}

BASE DE CONHECIMENTO:
${knowledgeText}

PERGUNTA DO CLIENTE:
${customerMessage}

Responda em ${agent.language || 'Português BR'}. Máximo ${maxLength} caracteres. Se não souber com certeza, diga que vai verificar.`
  }

  private async callAI(provider: string, model: string, prompt: string): Promise<string | null> {
    try {
      if (provider === 'openai') {
        const res = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 600,
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } },
        )
        return res.data.choices?.[0]?.message?.content ?? null
      }

      // Default: Anthropic
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: model || 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        },
      )
      return res.data.content?.[0]?.text ?? null
    } catch (err) {
      this.logger.error('[callAI]', (err as Error).message)
      return null
    }
  }

  private estimateConfidence(response: string, question: string): number {
    // Heuristic: long responses with specific info = higher confidence
    if (response.includes('verificar') || response.includes('não sei') || response.includes('não tenho')) return 45
    if (response.length < 30) return 50
    if (response.length > 100) return 85
    return 70
  }

  private async sendMlAnswer(token: string, questionId: number, text: string) {
    try {
      await axios.post(
        `https://api.mercadolibre.com/answers`,
        { question_id: questionId, text },
        { headers: { Authorization: `Bearer ${token}` } },
      )
    } catch (err) {
      this.logger.warn('[sendMlAnswer]', (err as Error).message)
    }
  }

  private async updateAnalytics(agentId: string, channel: string, autoReplied: boolean) {
    const today = new Date().toISOString().split('T')[0]

    const { data: existing } = await supabaseAdmin
      .from('ai_agent_analytics')
      .select('*')
      .eq('agent_id', agentId)
      .eq('channel', channel)
      .eq('date', today)
      .maybeSingle()

    if (existing) {
      await supabaseAdmin
        .from('ai_agent_analytics')
        .update({
          messages_received: existing.messages_received + 1,
          messages_auto_replied: existing.messages_auto_replied + (autoReplied ? 1 : 0),
        })
        .eq('id', existing.id)
    } else {
      await supabaseAdmin
        .from('ai_agent_analytics')
        .insert({
          agent_id: agentId,
          channel,
          date: today,
          messages_received: 1,
          messages_auto_replied: autoReplied ? 1 : 0,
        })
    }
  }
}
