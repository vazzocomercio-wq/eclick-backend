/** Reasoning IA para recomendacoes do Campaign Center.
 *
 *  Fluxo:
 *  1. Verifica cap diario via somatoria de cost_usd em ml_campaigns_ai_usage_log.
 *  2. Se cap atingido OR ai_reasoning_enabled=false na config -> retorna null
 *     (caller usa template deterministico como fallback).
 *  3. Caso contrario, monta prompt com contexto e chama LlmService.generateText.
 *  4. Loga em ml_campaigns_ai_usage_log (separado do ai_usage_log global) com
 *     custo, tokens, recommendation_id pra auditoria fina.
 *
 *  Defesa em profundidade: erro na chamada LLM -> retorna null silenciosamente,
 *  caller fica com texto deterministico. Decision engine nunca falha por causa
 *  de IA.
 */

import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

interface ReasoningContext {
  orgId:                 string
  sellerId:              number
  recommendationId?:     string
  // Contexto da recomendacao
  campaign: {
    name:                string | null
    promotion_type:      string
    deadline_date:       string | null
    has_subsidy_items:   boolean
    avg_meli_subsidy_pct:number | null
  }
  item: {
    ml_item_id:          string
    original_price:      number | null
    has_meli_subsidy:    boolean
    meli_percentage:     number | null
  }
  cost_breakdown:        Record<string, number>
  scenarios: {
    conservative?: { price: number; margin_pct: number; margin_brl: number }
    competitive?:  { price: number; margin_pct: number; margin_brl: number }
    aggressive?:   { price: number; margin_pct: number; margin_brl: number }
    break_even?:   { price: number }
  }
  quantity_recommendation: {
    current_stock:           number
    avg_daily_sales:         number
    recommended_max_qty:     number
    rupture_risk:            string
  }
  score: { total: number; breakdown: Record<string, number> }
  classification: {
    type:     string
    strategy: string | null
    price:    number | null
  }
  sales_30d?:            number
}

interface ConfigRow {
  ai_daily_cap_usd:      number
  ai_alert_at_pct:       number
  ai_reasoning_enabled:  boolean
}

@Injectable()
export class MlCampaignsReasoningService {
  private readonly logger = new Logger(MlCampaignsReasoningService.name)

  constructor(private readonly llm: LlmService) {}

  /** Tenta gerar reasoning IA. Retorna null se cap ou falha — caller
   *  deve ter fallback deterministico ja calculado. */
  async generateReasoning(ctx: ReasoningContext): Promise<{
    text:           string
    provider:       string
    model:          string
    cost_usd:       number
    input_tokens:   number
    output_tokens:  number
    duration_ms:    number
  } | null> {
    const t0 = Date.now()

    // 1. Carrega config
    const { data: cfgRow } = await supabaseAdmin
      .from('ml_campaigns_config')
      .select('ai_daily_cap_usd, ai_alert_at_pct, ai_reasoning_enabled')
      .eq('organization_id', ctx.orgId)
      .eq('seller_id', ctx.sellerId)
      .maybeSingle()
    const cfg = (cfgRow as ConfigRow | null) ?? {
      ai_daily_cap_usd: 10, ai_alert_at_pct: 80, ai_reasoning_enabled: true,
    }

    if (!cfg.ai_reasoning_enabled) {
      this.logger.debug('[reasoning] disabled em config — usa fallback deterministico')
      return null
    }

    // 2. Verifica cap diario (soma cost_usd de todas as logs hoje)
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const { data: logs } = await supabaseAdmin
      .from('ml_campaigns_ai_usage_log')
      .select('cost_usd')
      .eq('organization_id', ctx.orgId)
      .gte('created_at', todayStart.toISOString())
    const usedToday = ((logs ?? []) as Array<{ cost_usd: number }>).reduce((s, l) => s + (l.cost_usd ?? 0), 0)

    if (usedToday >= cfg.ai_daily_cap_usd) {
      this.logger.warn(`[reasoning] cap diario atingido org=${ctx.orgId}: $${usedToday.toFixed(4)}/${cfg.ai_daily_cap_usd}`)
      return null
    }

    // 3. Monta prompt e chama LLM
    const prompt = this.buildPrompt(ctx)
    let result
    try {
      result = await this.llm.generateText({
        orgId:        ctx.orgId,
        feature:      'ml_campaign_reasoning',
        systemPrompt: 'Você é analista comercial sênior em e-commerce no Mercado Livre. Análises sucintas, técnicas, sem jargão de marketing.',
        userPrompt:   prompt,
        maxTokens:    400,
        temperature:  0.4,
      })
    } catch (e) {
      const msg = (e as Error).message
      this.logger.warn(`[reasoning] LLM falhou (fallback deterministico): ${msg}`)

      // Loga falha pra debug (best effort — nunca propaga erro)
      try {
        await supabaseAdmin
          .from('ml_campaigns_ai_usage_log')
          .insert({
            organization_id:   ctx.orgId,
            seller_id:         ctx.sellerId,
            recommendation_id: ctx.recommendationId ?? null,
            provider:          'unknown',
            model:             'unknown',
            input_tokens:      0,
            output_tokens:     0,
            cost_usd:          0,
            duration_ms:       Date.now() - t0,
            success:           false,
            error_message:     msg.slice(0, 500),
          })
      } catch { /* ignora */ }

      return null
    }

    // 4. Loga sucesso
    await supabaseAdmin
      .from('ml_campaigns_ai_usage_log')
      .insert({
        organization_id:   ctx.orgId,
        seller_id:         ctx.sellerId,
        recommendation_id: ctx.recommendationId ?? null,
        provider:          result.provider,
        model:             result.model,
        input_tokens:      result.inputTokens,
        output_tokens:     result.outputTokens,
        cost_usd:          result.costUsd,
        duration_ms:       result.latencyMs,
        success:           true,
      })

    return {
      text:          result.text.trim(),
      provider:      result.provider,
      model:         result.model,
      cost_usd:      result.costUsd,
      input_tokens:  result.inputTokens,
      output_tokens: result.outputTokens,
      duration_ms:   result.latencyMs,
    }
  }

  private buildPrompt(ctx: ReasoningContext): string {
    const c = ctx.campaign
    const i = ctx.item
    const s = ctx.scenarios
    const q = ctx.quantity_recommendation
    const cb = ctx.cost_breakdown

    return `Analise esta oportunidade de campanha no Mercado Livre e retorne uma recomendacao em PT-BR (max 180 palavras).

## CAMPANHA
- Tipo: ${c.promotion_type}
- Nome: ${c.name ?? '—'}
- Subsidio MELI: ${c.has_subsidy_items ? `${c.avg_meli_subsidy_pct?.toFixed(1) ?? '?'}% (campanha tem subsidio em alguns items)` : 'Nao'}
${c.deadline_date ? `- Prazo p/ aderir: ${c.deadline_date}` : ''}

## ANUNCIO
- ML item: ${i.ml_item_id}
- Preco original: R$ ${i.original_price?.toFixed(2) ?? '—'}
- Subsidio neste item: ${i.has_meli_subsidy ? `ML reduz ${i.meli_percentage?.toFixed(1) ?? '?'}% da tarifa` : 'Nao'}

## CUSTOS (no preco competitivo)
- Custo do produto: R$ ${cb.cost_price?.toFixed(2) ?? '—'}
- Imposto: R$ ${cb.tax_amount?.toFixed(2) ?? '—'} (${cb.tax_percentage}%)
- Comissao ML: R$ ${cb.ml_commission?.toFixed(2) ?? '—'} (${cb.ml_commission_pct}%)
- Subsidio ML: R$ ${cb.meli_subsidy_brl?.toFixed(2) ?? '0'} (positivo = abate custo)
- Custo total: R$ ${cb.total_costs?.toFixed(2) ?? '—'}
- Receita liquida (M.C.): R$ ${cb.net_revenue?.toFixed(2) ?? '—'}

## CENARIOS
- Conservador: R$ ${s.conservative?.price.toFixed(2) ?? '—'} (M.C. ${s.conservative?.margin_pct.toFixed(1) ?? '—'}%)
- Competitivo: R$ ${s.competitive?.price.toFixed(2) ?? '—'} (M.C. ${s.competitive?.margin_pct.toFixed(1) ?? '—'}%) [escolhido pelo engine]
- Agressivo:   R$ ${s.aggressive?.price.toFixed(2) ?? '—'} (M.C. ${s.aggressive?.margin_pct.toFixed(1) ?? '—'}%)
- Break-even: R$ ${s.break_even?.price.toFixed(2) ?? '—'}

## ESTOQUE
- Atual: ${q.current_stock} un
- Vendas/dia (avg 30d): ${q.avg_daily_sales}
- Recomendado pra campanha: ${q.recommended_max_qty} un
- Risco de ruptura: ${q.rupture_risk}

## SCORE INTERNO: ${ctx.score.total}/100
- sales_potential: ${ctx.score.breakdown.sales_potential ?? 0}/30
- subsidy: ${ctx.score.breakdown.subsidy ?? 0}/20
- final_margin: ${ctx.score.breakdown.final_margin ?? 0}/20
- stock_availability: ${ctx.score.breakdown.stock_availability ?? 0}/10
- stock_turnover_need: ${ctx.score.breakdown.stock_turnover_need ?? 0}/10
- competitiveness: ${ctx.score.breakdown.competitiveness ?? 0}/10
- risk_penalty: ${ctx.score.breakdown.risk_penalty ?? 0}

## CLASSIFICACAO DO ENGINE: ${ctx.classification.type}
Estrategia: ${ctx.classification.strategy ?? '—'}
Preco recomendado: R$ ${ctx.classification.price?.toFixed(2) ?? '—'}

## TAREFA
Escreva uma recomendacao clara em PT-BR (max 180 palavras) seguindo a estrutura:
1. Veredito direto numa frase (✅/⚠️/♻️/❌ + motivo principal).
2. Driver financeiro: o que faz essa oportunidade ser boa ou ruim (margem, subsidio, demanda).
3. Atencao/risco se houver.
4. Acao concreta: preco + quantidade sugeridos.

NAO use markdown, NAO use bullets, NAO repita os numeros do contexto literalmente. Tom: analista comercial direto, sem floreio.
Retorne APENAS o texto da recomendacao.`
  }
}
