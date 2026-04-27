import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { CredentialsService } from '../../credentials/credentials.service'
import { AdsAiService } from '../ads-ai.service'
import { ContextBuilderService } from './context-builder.service'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

const SYSTEM_PROMPT = `Você é um especialista em ML Ads para a {{org_name}}, marketplace seller.
Você tem acesso a dados em tempo real de campanhas, estoque, margens, concorrentes e pedidos via tools.

Diretrizes:
- Seja direto e numérico — sempre use números reais quando disponíveis (R$, %, ROAS).
- Quando recomendar pausar uma campanha ou alterar budget, peça confirmação ao usuário antes
  (mencione que a ação requer aprovação).
- Calcule impactos em R$ sempre que possível.
- Português brasileiro, técnico mas acessível.
- Use markdown (negrito, listas) pra organizar.
- Se faltar informação pra responder, chame as tools antes de chutar.
`

// Tool definitions in Anthropic Messages API format
const TOOLS = [
  {
    name: 'get_campaigns',
    description: 'Lista todas as campanhas com métricas agregadas dos últimos 30 dias.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_product_stock',
    description: 'Retorna estoque atual + dias estimados de estoque para um produto (por SKU ou ID).',
    input_schema: {
      type: 'object',
      properties: { product_or_sku: { type: 'string', description: 'SKU ou UUID do produto' } },
      required: ['product_or_sku'],
    },
  },
  {
    name: 'get_product_margin',
    description: 'Custo, taxa, preço e margem (R$ + %) do produto pelo ID.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
    },
  },
  {
    name: 'get_competitor_prices',
    description: 'Preços dos concorrentes ativos para um produto.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
    },
  },
  {
    name: 'get_recent_orders',
    description: 'Pedidos recentes do produto. Útil pra entender velocidade de venda.',
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        days:       { type: 'number', description: 'Padrão 30' },
      },
      required: ['product_id'],
    },
  },
  {
    name: 'get_open_insights',
    description: 'Lista os insights abertos (alertas detectados automaticamente).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pause_campaign',
    description: 'Pausa uma campanha. AÇÃO DESTRUTIVA — só execute após confirmação explícita do usuário.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        confirmed:   { type: 'boolean', description: 'true se o usuário já confirmou' },
      },
      required: ['campaign_id'],
    },
  },
  {
    name: 'adjust_budget',
    description: 'Ajusta o budget diário de uma campanha. AÇÃO DESTRUTIVA — só execute após confirmação.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string' },
        new_budget:  { type: 'number' },
        confirmed:   { type: 'boolean' },
      },
      required: ['campaign_id', 'new_budget'],
    },
  },
] as const

interface AnthropicContentBlock {
  type:  'text' | 'tool_use'
  text?: string
  id?:   string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicResponse {
  id:           string
  content:      AnthropicContentBlock[]
  stop_reason:  string
  usage:        { input_tokens: number; output_tokens: number }
}

@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name)

  constructor(
    private readonly settings: AdsAiService,
    private readonly ctx: ContextBuilderService,
    private readonly credentials: CredentialsService,
  ) {}

  /** Returns the assistant's final reply as ONE chunk (SSE-friendly).
   * The server-side loop runs all tool calls before emitting any text,
   * so the user sees a single coherent answer per turn. */
  async runTurn(
    orgId:         string,
    conversationId: string,
    userMessage:    string,
  ): Promise<{ text: string; tokens_in: number; tokens_out: number; tool_calls: AnthropicContentBlock[] }> {
    const settings = await this.settings.getSettings(orgId)
    const apiKey   = await this.credentials.getDecryptedKey(null, 'anthropic', 'ANTHROPIC_API_KEY').catch(() => null)
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada nas credenciais')

    // Persist user message
    await supabaseAdmin.from('ads_ai_messages').insert({
      conversation_id: conversationId, role: 'user', content: userMessage,
    })

    // Build message history (last 20 turns to keep context lean)
    const { data: history } = await supabaseAdmin
      .from('ads_ai_messages')
      .select('role, content, tool_calls, tool_results')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(40)

    type ApiMessage = { role: 'user' | 'assistant'; content: unknown }
    const messages: ApiMessage[] = (history ?? [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as unknown as string }))

    const systemPrompt = SYSTEM_PROMPT.replace('{{org_name}}', 'sua loja')

    const allToolCalls: AnthropicContentBlock[] = []
    let totalIn = 0
    let totalOut = 0
    let finalText = ''

    // Tool-use loop, max 6 iterations to bound cost/latency
    for (let i = 0; i < 6; i++) {
      const res = await axios.post<AnthropicResponse>(
        ANTHROPIC_URL,
        {
          model:      settings.model_id,
          max_tokens: 1024,
          system:     systemPrompt,
          tools:      TOOLS,
          messages,
        },
        {
          headers: {
            'x-api-key':         apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type':      'application/json',
          },
        },
      )

      totalIn  += res.data.usage?.input_tokens  ?? 0
      totalOut += res.data.usage?.output_tokens ?? 0

      const blocks = Array.isArray(res.data.content) ? res.data.content : []
      const toolUses = blocks.filter(b => b.type === 'tool_use')
      const texts    = blocks.filter(b => b.type === 'text')

      // Always append the assistant turn (text + tool_use) to the running history
      messages.push({ role: 'assistant', content: blocks })

      if (toolUses.length === 0) {
        finalText = texts.map(t => t.text ?? '').join('\n').trim()
        break
      }

      // Resolve every tool call and append a single user message with results
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = []
      for (const tu of toolUses) {
        allToolCalls.push(tu)
        const result = await this.runTool(orgId, tu.name ?? '', tu.input ?? {})
        toolResults.push({
          type:        'tool_result',
          tool_use_id: tu.id ?? '',
          content:     JSON.stringify(result).slice(0, 8000),
        })
      }
      messages.push({ role: 'user', content: toolResults })
    }

    // Persist assistant message
    await supabaseAdmin.from('ads_ai_messages').insert({
      conversation_id: conversationId,
      role:            'assistant',
      content:         finalText || '(sem resposta)',
      tool_calls:      allToolCalls.length ? allToolCalls : null,
      tokens_used:     totalIn + totalOut,
    })

    // Bump conversation totals + updated_at
    await supabaseAdmin.from('ads_ai_conversations')
      .update({
        total_tokens: (totalIn + totalOut),
        model_used:   settings.model_id,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', conversationId)

    return { text: finalText, tokens_in: totalIn, tokens_out: totalOut, tool_calls: allToolCalls }
  }

  /** Dispatches one tool call. Returns the result as plain JSON-serializable
   * data. Errors are caught and returned as { error } so the loop continues. */
  private async runTool(orgId: string, name: string, input: Record<string, unknown>): Promise<unknown> {
    try {
      switch (name) {
        case 'get_campaigns':
          return await this.ctx.loadCampaignsContext(orgId)
        case 'get_product_stock':
          return await this.ctx.getProductStock(orgId, String(input.product_or_sku ?? ''))
        case 'get_product_margin':
          return await this.ctx.getProductMargin(orgId, String(input.product_id ?? ''))
        case 'get_competitor_prices':
          return await this.ctx.getCompetitorPrices(orgId, String(input.product_id ?? ''))
        case 'get_recent_orders':
          return await this.ctx.getRecentOrders(orgId, String(input.product_id ?? ''), Number(input.days ?? 30))
        case 'get_open_insights': {
          const { data } = await supabaseAdmin
            .from('ads_ai_insights')
            .select('id, type, severity, campaign_id, campaign_name, title, description, recommendation, created_at')
            .eq('organization_id', orgId).eq('status', 'open')
            .order('created_at', { ascending: false }).limit(20)
          return data ?? []
        }
        case 'pause_campaign':
        case 'adjust_budget':
          if (!input.confirmed) {
            return { needs_confirmation: true, message: 'Esta ação requer confirmação explícita do usuário.' }
          }
          // Actual ML Ads mutation isn't wired yet — return a clear note.
          return { ok: false, note: `Ação "${name}" reconhecida; integração de mutação ML Ads ainda pendente.` }
        default:
          return { error: `tool desconhecida: ${name}` }
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[ads-ai.tool.${name}] ${err?.message}`)
      return { error: err?.message ?? 'erro' }
    }
  }
}
