import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { ConversationsService } from './conversations.service'
import { CredentialsService } from '../credentials/credentials.service'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { AiUsageService } from '../ai-usage/ai-usage.service'

interface MlQuestion {
  id: number
  item_id: string
  text: string
  date_created: string
  from?: { nickname: string; id: number }
  item?: { title: string; price: number; thumbnail: string }
}

const COST_PER_1K: Record<string, Record<string, { input: number; output: number }>> = {
  anthropic: {
    'claude-haiku-4-5-20251001': { input: 0.00025, output: 0.00125 },
    'claude-sonnet-4-6':         { input: 0.003,   output: 0.015   },
    'claude-opus-4-6':           { input: 0.015,   output: 0.075   },
  },
  openai: {
    'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
    'gpt-4o':      { input: 0.005,   output: 0.015  },
  },
}

function calcCost(provider: string, model: string, inp: number, out: number): number {
  const p = COST_PER_1K[provider]?.[model]
  if (!p) return 0
  return (inp / 1000) * p.input + (out / 1000) * p.output
}

@Injectable()
export class AiResponderService {
  private readonly logger = new Logger(AiResponderService.name)

  constructor(
    private readonly conversations: ConversationsService,
    private readonly credentials: CredentialsService,
    private readonly mlService: MercadolivreService,
    private readonly aiUsage: AiUsageService,
  ) {}

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
          .eq('channel', 'mercadolivre')
          .eq('is_active', true)
          .limit(1)
          .maybeSingle()

        if (!agentChannel?.agent) continue

        await this.processOrgMlQuestions(conn.seller_id, agentChannel)
      }
    } catch (err) {
      this.logger.error('[pollMlQuestions]', (err as Error).message)
    }
  }

  private async processOrgMlQuestions(sellerId: number, agentChannel: any) {
    try {
      const connections = await this.mlService.getAllConnections()
      const conn = connections.find(c => c.seller_id === sellerId) ?? connections[0]
      if (!conn) return

      const token = (conn as any).access_token
      const res   = await axios.get(
        `https://api.mercadolibre.com/questions/search?seller_id=${sellerId}&status=UNANSWERED&limit=20`,
        { headers: { Authorization: `Bearer ${token}` } },
      )

      const questions: MlQuestion[] = res.data?.questions ?? []

      for (const q of questions) {
        // Skip if already processed
        const { data: existing } = await supabaseAdmin
          .from('ai_conversations')
          .select('id')
          .eq('channel', 'mercadolivre')
          .eq('external_conversation_id', String(q.id))
          .maybeSingle()

        if (existing) continue

        // Fetch product info linked to this listing
        const { data: vinculo } = await supabaseAdmin
          .from('product_listings')
          .select('product:products(id, name, sku, cost_price, tax_percentage, supply_type, lead_time_days)')
          .eq('listing_id', q.item_id)
          .eq('is_active', true)
          .maybeSingle()

        await this.processIncomingMessage({
          channel: 'mercadolivre',
          agentChannel,
          externalConvId:    String(q.id),
          externalCustomerId: String(q.from?.id ?? ''),
          customerName:      q.from?.nickname ?? 'Comprador',
          customerMessage:   q.text,
          productInfo: {
            listing_id: q.item_id,
            title:      q.item?.title,
            thumbnail:  q.item?.thumbnail,
            price:      q.item?.price,
            product:    (vinculo as any)?.product ?? null,
          },
        })
      }
    } catch (err) {
      this.logger.warn('[processOrgMlQuestions]', (err as Error).message)
    }
  }

  // ── Core processor ────────────────────────────────────────────────────────

  async processIncomingMessage(opts: {
    channel: string
    agentChannel: any
    externalConvId: string
    externalCustomerId: string
    customerName: string
    customerMessage: string
    productInfo: {
      listing_id?: string
      title?: string
      thumbnail?: string
      price?: number
      product?: any
    }
  }) {
    const { agentChannel, channel, externalConvId, customerMessage, externalCustomerId, customerName, productInfo } = opts
    const { agent } = agentChannel

    this.logger.log(`[ai-responder] canal:${channel} agente:${agent.name} conv:${externalConvId}`)

    // 1. Upsert conversation
    const conv = await this.conversations.upsertConversation({
      agent_id: agent.id,
      channel,
      external_conversation_id: externalConvId,
      external_customer_id:     externalCustomerId,
      customer_name:            customerName,
      customer_nickname:        customerName,
      listing_id:               productInfo.listing_id,
      listing_title:            productInfo.title,
    })

    // 2. Save customer message (idempotent)
    const existingMsgs = await this.conversations.getMessages(conv.id)
    const alreadySaved = existingMsgs.some(m => m.content === customerMessage && m.role === 'customer')
    if (!alreadySaved) {
      await this.conversations.addMessage({
        conversation_id:     conv.id,
        role:                'customer',
        content:             customerMessage,
        external_message_id: externalConvId,
      })
    }

    // 3. Check escalation keywords
    const lowerMsg = customerMessage.toLowerCase()
    const shouldEscalate = (agentChannel.escalate_keywords ?? []).some((kw: string) =>
      lowerMsg.includes(kw.toLowerCase()),
    )
    if (shouldEscalate) {
      await this.conversations.escalate(conv.id)
      return
    }

    // 4. Human-only mode
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
        .select('type, title, content')
        .eq('agent_id', agent.id)
        .eq('is_active', true)
        .limit(20),
      supabaseAdmin
        .from('ai_messages')
        .select('role, content')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: false })
        .limit(10),
    ])

    const knowledge      = knowledgeRes.data ?? []
    const recentMessages = (messagesRes.data ?? []).reverse()

    // 6. Build prompts
    const systemPrompt = this.buildSystemPrompt(agent, productInfo, knowledge)
    const userPrompt   = this.buildUserPrompt(customerMessage, recentMessages)

    // 7. Get API key from DB
    const keyName = agent.model_provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
    const apiKey  = await this.credentials.getDecryptedKey(null, agent.model_provider, keyName)

    if (!apiKey) {
      this.logger.error(`[ai-responder] API key não encontrada para ${agent.model_provider}`)
      return
    }

    // 8. Call AI
    const aiResult = await this.callAI(agent.model_provider, agent.model_id, systemPrompt, userPrompt, apiKey)
    if (!aiResult) return

    const { content, confidence, reasoning, tokensIn, tokensOut } = aiResult

    const autoSend = agentChannel.mode === 'auto' ||
      (agentChannel.mode === 'hybrid' && confidence >= (agentChannel.confidence_threshold ?? 80))

    // 9. Save AI message
    await this.conversations.addMessage({
      conversation_id: conv.id,
      role:            'agent',
      content,
      ai_provider:     agent.model_provider,
      ai_model:        agent.model_id,
      ai_confidence:   confidence,
      ai_reasoning:    reasoning,
      was_auto_sent:   autoSend,
    })

    // 10. Auto-send to ML if applicable
    if (autoSend && channel === 'mercadolivre') {
      if ((agentChannel.auto_reply_delay_seconds ?? 0) > 0) {
        await new Promise(r => setTimeout(r, agentChannel.auto_reply_delay_seconds * 1000))
      }
      try {
        await this.mlService.answerQuestion(null, Number(externalConvId), content)
        this.logger.log(`[ai-responder] resposta enviada ao ML conf:${confidence}%`)
      } catch (e: any) {
        this.logger.warn('[ai-responder] erro ao enviar ML:', e.message)
      }
    } else if (!autoSend) {
      await supabaseAdmin
        .from('ai_conversations')
        .update({ status: 'waiting_human', updated_at: new Date().toISOString() })
        .eq('id', conv.id)
      this.logger.log(`[ai-responder] aguardando aprovação humana conf:${confidence}%`)
    }

    // 11. Analytics
    await this.updateAnalytics(agent.id, channel, autoSend)

    // 12. Token usage
    if (tokensIn || tokensOut) {
      this.aiUsage.logUsage({
        provider:       agent.model_provider,
        model:          agent.model_id,
        feature:        'atendente_ml',
        tokens_input:   tokensIn,
        tokens_output:  tokensOut,
        tokens_total:   tokensIn + tokensOut,
        cost_usd:       calcCost(agent.model_provider, agent.model_id, tokensIn, tokensOut),
      }).catch(() => { /* fire-and-forget */ })
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildSystemPrompt(
    agent: { name: string; tone: string; language: string; system_prompt?: string },
    product: { listing_id?: string; title?: string; price?: number; product?: any },
    knowledge: Array<{ type?: string; title: string; content: string }>,
  ): string {
    const knowledgeText = knowledge.length
      ? knowledge.map(k => `[${(k.type ?? 'INFO').toUpperCase()}] ${k.title}: ${k.content}`).join('\n')
      : 'Nenhuma informação adicional cadastrada.'

    const productExtra = product.product
      ? `SKU: ${product.product.sku ?? 'N/A'}\nCusto: R$ ${product.product.cost_price ?? 'N/A'}`
      : ''

    return `${agent.system_prompt || `Você é ${agent.name}, atendente virtual de e-commerce. Responda de forma ${agent.tone} e precisa.`}

PRODUTO DA CONVERSA:
Título: ${product.title ?? 'sem informação'}
Preço: R$ ${product.price ?? 'sem informação'}
${productExtra}

BASE DE CONHECIMENTO:
${knowledgeText}

REGRAS:
1. Responda em ${agent.language || 'Português BR'}, máximo 350 caracteres
2. Seja ${agent.tone || 'educado e prestativo'}
3. Se NÃO tiver certeza da resposta, diga "Vou verificar e te respondo em breve" e NÃO invente
4. Se a pergunta envolver troca, devolução, reclamação ou problema, peça ao cliente aguardar atendente humano
5. NUNCA invente prazos, preços ou informações que não constam acima
6. Ao final da resposta, em uma nova linha separada, retorne SOMENTE este JSON:
{"confidence": 0-100, "reasoning": "breve explicação"}

Confiança: 90-100 = informação exata | 70-89 = informação relacionada | 50-69 = inferindo contexto | 0-49 = não sei`
  }

  private buildUserPrompt(message: string, history: Array<{ role: string; content: string }>): string {
    const historyText = history.length > 1
      ? `Histórico:\n${history.slice(0, -1).map(m => `${m.role === 'customer' ? 'Cliente' : 'Agente'}: ${m.content}`).join('\n')}\n\n`
      : ''
    return `${historyText}Nova pergunta do cliente:\n${message}`
  }

  private async callAI(
    provider: string,
    model: string,
    systemPrompt: string,
    userPrompt: string,
    apiKey: string,
  ): Promise<{ content: string; confidence: number; reasoning: string; tokensIn: number; tokensOut: number } | null> {
    try {
      if (provider === 'openai') {
        const res = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: model || 'gpt-4o-mini',
            max_tokens: 600,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user',   content: userPrompt },
            ],
          },
          { headers: { Authorization: `Bearer ${apiKey}` } },
        )
        const text = res.data.choices?.[0]?.message?.content ?? ''
        return this.parseAiResponse(text, res.data.usage?.prompt_tokens ?? 0, res.data.usage?.completion_tokens ?? 0)
      }

      // Default: Anthropic
      const res = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model:      model || 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userPrompt }],
        },
        {
          headers: {
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
            'content-type':      'application/json',
          },
        },
      )
      const text = res.data.content?.[0]?.text ?? ''
      return this.parseAiResponse(text, res.data.usage?.input_tokens ?? 0, res.data.usage?.output_tokens ?? 0)
    } catch (err) {
      this.logger.error('[callAI]', (err as Error).message)
      return null
    }
  }

  private parseAiResponse(text: string, tokensIn: number, tokensOut: number) {
    let confidence = 50
    let reasoning  = ''
    let content    = text.trim()

    const jsonMatch = text.match(/\{[^{}]*"confidence"[^{}]*\}/)
    if (jsonMatch) {
      try {
        const parsed  = JSON.parse(jsonMatch[0])
        confidence    = typeof parsed.confidence === 'number' ? parsed.confidence : 50
        reasoning     = parsed.reasoning ?? ''
        content       = text.replace(jsonMatch[0], '').trim()
      } catch { /* keep defaults */ }
    }

    return { content, confidence, reasoning, tokensIn, tokensOut }
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
          messages_received:     existing.messages_received + 1,
          messages_auto_replied: existing.messages_auto_replied + (autoReplied ? 1 : 0),
        })
        .eq('id', existing.id)
    } else {
      await supabaseAdmin
        .from('ai_agent_analytics')
        .insert({
          agent_id:              agentId,
          channel,
          date:                  today,
          messages_received:     1,
          messages_auto_replied: autoReplied ? 1 : 0,
        })
    }
  }
}
