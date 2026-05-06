import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { LlmService } from '../ai/llm.service'
import { supabaseAdmin } from '../../common/supabase'
import { PricingAiService } from '../pricing-ai/pricing-ai.service'
import { AdsCampaignsService } from '../ads-campaigns/ads-campaigns.service'
import { SocialContentService } from '../social-content/social-content.service'
import { KitsService } from '../kits/kits.service'
import { StorefrontService } from '../storefront/storefront.service'
import { StoreAutomationService } from '../store-automation/store-automation.service'
import type {
  StoreCopilotResponse, StoreCopilotIntent, ChatMessage,
} from './store-copilot.types'

const SYSTEM_PROMPT = `Você é o copiloto de loja do e-Click (admin assistant).

Sua função: ajudar o LOJISTA a operar a loja em linguagem natural.
Você executa ações reais via "intents" — não invente capacidades.

INTENTS DISPONÍVEIS:
- answer:                   só responde dúvida/pergunta
- clarification:            faltou info, peça ao user
- analyze_pricing:          disparar análise IA pra TODOS os produtos
- generate_collections:     IA gera coleções (params: count: 1-10)
- generate_kits:            IA gera kits (params: count: 1-10)
- generate_social_content:  gerar conteúdo (params: product_id, channels[])
- create_ads_campaign:      criar campanha (params: product_id, platform, objective)
- pause_ads_campaign:       (params: campaign_id)
- enrich_products:          marca produtos pra enriquecer (params: product_ids[])
- analyze_store:            roda detecção de automações
- list_pending_actions:     lista ações pendentes
- get_sales_summary:        resumo de vendas (params: days: number)
- get_top_products:         top N produtos (params: criterion, limit)

REGRAS:
- Pra ações que custam dinheiro (campanha) ou alteram preço, sempre
  requires_confirmation=true
- Pra geração de conteúdo IA, requires_confirmation=true
- Pra ações de leitura (get_*, list_*, analyze_*), requires_confirmation=false
- Limit batch a 50 itens
- Se user pediu algo fora dos intents, intent='answer' e explique o limite
- NUNCA invente product_ids ou campaign_ids

SAÍDA JSON PURO:
{
  "intent": "<intent name>",
  "message": "texto curto que o copiloto vai falar (português brasileiro, tom direto)",
  "requires_confirmation": boolean,
  "params": { ... }
}`

@Injectable()
export class StoreCopilotService {
  private readonly logger = new Logger(StoreCopilotService.name)

  constructor(
    private readonly llm:        LlmService,
    private readonly pricing:    PricingAiService,
    private readonly ads:        AdsCampaignsService,
    private readonly social:     SocialContentService,
    private readonly kits:       KitsService,
    private readonly storefront: StorefrontService,
    private readonly automation: StoreAutomationService,
  ) {}

  /** User envia mensagem. Sonnet classifica intent. Service executa
   *  imediatamente se requires_confirmation=false; senão devolve resposta
   *  pra UI mostrar diálogo de confirmação. */
  async message(input: {
    orgId:    string
    userId:   string
    message:  string
    history?: ChatMessage[]
    auto_confirm?: boolean   // se user clicou "confirmar e executar"
  }): Promise<StoreCopilotResponse & { cost_usd: number }> {
    if (!input.message?.trim()) {
      throw new BadRequestException('message obrigatório')
    }

    const history = input.history?.slice(-6) ?? []
    const userPrompt = `${history.length > 0
      ? `## HISTÓRICO\n${history.map(h => `${h.role}: ${h.content}`).join('\n')}\n\n`
      : ''}## NOVA MENSAGEM
${input.message}

## SAÍDA
JSON puro conforme regras do system prompt.`

    const out = await this.llm.generateText({
      orgId:        input.orgId,
      feature:      'store_copilot',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens:    600,
      temperature:  0.2,
      jsonMode:     true,
    })

    let parsed: StoreCopilotResponse
    try {
      parsed = JSON.parse(out.text) as StoreCopilotResponse
    } catch {
      throw new BadRequestException('Copiloto retornou JSON inválido — tente reformular')
    }

    // Se requires_confirmation e user não confirmou, devolve sem executar
    if (parsed.requires_confirmation && !input.auto_confirm) {
      return { ...parsed, executed: false, cost_usd: out.costUsd }
    }

    // Executa
    try {
      const result = await this.dispatch(parsed.intent, parsed.params, input)
      return {
        ...parsed,
        executed:         true,
        execution_result: result,
        cost_usd:         out.costUsd,
      }
    } catch (e) {
      return {
        ...parsed,
        executed:         false,
        execution_result: { error: (e as Error).message },
        cost_usd:         out.costUsd,
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // DISPATCHER
  // ─────────────────────────────────────────────────────────────────

  private async dispatch(intent: StoreCopilotIntent, params: Record<string, unknown>, ctx: { orgId: string; userId: string }): Promise<Record<string, unknown>> {
    const orgId  = ctx.orgId
    const userId = ctx.userId

    switch (intent) {
      case 'answer':
      case 'clarification':
        return {}

      case 'analyze_pricing': {
        const r = await this.pricing.analyzeAll(orgId, { maxItems: Number(params.max_items) || 30 })
        return r as unknown as Record<string, unknown>
      }

      case 'generate_collections': {
        const count = Math.min(Number(params.count) || 5, 10)
        const r = await this.storefront.generateCollections(orgId, count)
        return { count: r.collections.length, cost_usd: r.cost_usd }
      }

      case 'generate_kits': {
        const count = Math.min(Number(params.count) || 5, 10)
        const r = await this.kits.generate(orgId, { count })
        return { count: r.kits.length, cost_usd: r.cost_usd }
      }

      case 'generate_social_content': {
        const productId = String(params.product_id ?? '')
        if (!productId) throw new BadRequestException('product_id obrigatório')
        const channels = (Array.isArray(params.channels) ? params.channels : ['instagram_post']) as Parameters<SocialContentService['generateForProduct']>[0]['channels']
        const r = await this.social.generateForProduct({
          orgId, userId, productId, channels,
        })
        return { generated: r.items.length, cost_usd: r.cost_usd }
      }

      case 'create_ads_campaign': {
        const productId = String(params.product_id ?? '')
        if (!productId) throw new BadRequestException('product_id obrigatório')
        const r = await this.ads.generateForProduct({
          orgId, userId, productId,
          platform:  (params.platform  as 'meta' | 'google' | 'tiktok' | 'mercado_livre_ads') ?? 'meta',
          objective: (params.objective as 'traffic' | 'conversions' | 'engagement' | 'awareness' | 'catalog_sales' | 'leads') ?? 'conversions',
        })
        return { campaign_id: r.campaign.id, name: r.campaign.name, cost_usd: r.cost_usd }
      }

      case 'pause_ads_campaign': {
        const campaignId = String(params.campaign_id ?? '')
        if (!campaignId) throw new BadRequestException('campaign_id obrigatório')
        await this.ads.pause(campaignId, orgId)
        return { campaign_id: campaignId, paused: true }
      }

      case 'enrich_products': {
        const ids = (Array.isArray(params.product_ids) ? params.product_ids : []) as string[]
        if (!ids.length) throw new BadRequestException('product_ids obrigatório')
        const { error } = await supabaseAdmin
          .from('products')
          .update({ ai_enrichment_pending: true })
          .in('id', ids.slice(0, 50))
          .eq('organization_id', orgId)
        if (error) throw new BadRequestException(`Erro: ${error.message}`)
        return { marked: ids.length }
      }

      case 'analyze_store': {
        const r = await this.automation.analyze(orgId)
        return r as unknown as Record<string, unknown>
      }

      case 'list_pending_actions': {
        const r = await this.automation.listActions(orgId, { status: 'pending', limit: 20 })
        return { count: r.total, items: r.items.slice(0, 5).map(a => ({ id: a.id, title: a.title, severity: a.severity })) }
      }

      case 'get_sales_summary': {
        const days = Math.min(Math.max(Number(params.days) || 7, 1), 90)
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        const { count: orderCount } = await supabaseAdmin
          .from('orders').select('id', { count: 'exact', head: true })
          .eq('organization_id', orgId).gte('created_at', since)
        return { days, total_orders: orderCount ?? 0 }
      }

      case 'get_top_products': {
        const limit = Math.min(Number(params.limit) || 5, 20)
        const { data } = await supabaseAdmin
          .from('products')
          .select('id, name, ai_score, price')
          .eq('organization_id', orgId)
          .neq('status', 'archived')
          .order('ai_score', { ascending: false })
          .limit(limit)
        return { products: (data ?? []) as Array<Record<string, unknown>> }
      }

      default:
        return {}
    }
  }
}
