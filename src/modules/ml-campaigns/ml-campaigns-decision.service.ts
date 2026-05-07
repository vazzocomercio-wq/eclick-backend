/** Motor de Decisao DETERMINISTICO — sem LLM ainda.
 *
 *  Pra cada (campaign_item) candidate, calcula:
 *   1. Cost breakdown
 *   2. 3 cenarios de preco (conservative/competitive/aggressive)
 *   3. Quantidade recomendada
 *   4. Score de oportunidade (0-100)
 *   5. Classifica (recommended / caution / clearance / skip / review_costs / low_quality)
 *   6. Reasoning textual via TEMPLATE (nao IA)
 *
 *  IA (LLM) entra na proxima iteracao pra reasoning enriquecido em
 *  casos cinzentos. Engine determinístico fica testavel e auditavel.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlCampaignsCostService } from './ml-campaigns-cost.service'
import { MlCampaignsReasoningService } from './ml-campaigns-reasoning.service'
import type {
  CostBreakdown,
  PriceScenario,
  PriceScenarios,
  QuantityRecommendation,
  ScoreBreakdown,
  ClassificationResult,
  CampaignsConfig,
} from './ml-campaigns.types'

interface CampaignItemRow {
  id:                          string
  organization_id:             string
  seller_id:                   number
  campaign_id:                 string
  product_id:                  string | null
  ml_item_id:                  string
  ml_promotion_type:           string
  status:                      string
  original_price:              number | null
  current_price:               number | null
  suggested_discounted_price:  number | null
  min_discounted_price:        number | null
  max_discounted_price:        number | null
  meli_percentage:             number | null
  seller_percentage:           number | null
  meli_subsidy_amount:         number | null
  has_meli_subsidy:            boolean
  min_quantity:                number | null
  max_quantity:                number | null
  health_status:               string | null
  health_warnings:             Array<{ code: string; message: string }>
}

@Injectable()
export class MlCampaignsDecisionService {
  private readonly logger = new Logger(MlCampaignsDecisionService.name)

  constructor(
    private readonly ml:        MercadolivreService,
    private readonly costs:     MlCampaignsCostService,
    private readonly reasoning: MlCampaignsReasoningService,
  ) {}

  // ── Geracao em lote ─────────────────────────────────────────────

  /** Gera recomendacoes pra todos os candidates pendentes (sem rec ativa). */
  async generateForOrg(orgId: string, sellerId?: number): Promise<{ generated: number; skipped: number }> {
    let q = supabaseAdmin
      .from('ml_campaign_items')
      .select('id')
      .eq('organization_id', orgId)
      .eq('status', 'candidate')
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data: items } = await q
    if (!items || items.length === 0) return { generated: 0, skipped: 0 }

    let generated = 0, skipped = 0
    for (const it of items as Array<{ id: string }>) {
      // Pula se ja tem reco pending pra esse item
      const { data: existing } = await supabaseAdmin
        .from('ml_campaign_recommendations')
        .select('id')
        .eq('campaign_item_id', it.id)
        .eq('status', 'pending')
        .maybeSingle()
      if (existing) { skipped++; continue }

      try {
        await this.generateForItem(it.id)
        generated++
      } catch (e) {
        this.logger.warn(`[decision] generateForItem falhou ${it.id}: ${(e as Error).message}`)
        skipped++
      }
    }
    return { generated, skipped }
  }

  /** Gera 1 recomendacao para 1 campaign_item. */
  async generateForItem(campaignItemId: string): Promise<{ id: string }> {
    const t0 = Date.now()

    // Carrega item completo
    const { data: itemRow, error } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('*')
      .eq('id', campaignItemId)
      .maybeSingle()
    if (error || !itemRow) throw new BadRequestException('campaign_item nao encontrado')
    const item = itemRow as CampaignItemRow

    const { data: campaignRow } = await supabaseAdmin
      .from('ml_campaigns')
      .select('*')
      .eq('id', item.campaign_id)
      .maybeSingle()
    if (!campaignRow) throw new BadRequestException('campanha nao encontrada')

    const config = await this.getConfig(item.organization_id, item.seller_id)
    const token  = (await this.ml.getTokenForOrg(item.organization_id, item.seller_id)).token

    // 1. Health check — se nao OK, vira review_costs
    if (item.health_status && item.health_status !== 'ready') {
      return this.saveReviewCosts(item, campaignRow, t0)
    }

    // 2. Quality gate
    if (config.quality_gate_enabled) {
      const qScore = await this.getQualityScore(item.organization_id, item.ml_item_id, item.seller_id)
      if (qScore != null && qScore < config.quality_gate_min_score) {
        return this.saveLowQuality(item, campaignRow, qScore, t0)
      }
    }

    // 3. Sales data + competidores (best-effort, nao bloqueante)
    const salesData = await this.getSalesData(item.product_id, 30)

    // 4. Custos (uses listing_prices cache)
    // Calcula no preco SUGERIDO pelo ML (pra ter base) ou no original
    const referencePrice = item.suggested_discounted_price
                       ?? (item.original_price != null ? item.original_price * 0.85 : 0)
    const costBreakdown = await this.costs.calculate({
      orgId:             item.organization_id,
      sellerId:          item.seller_id,
      productId:         item.product_id,
      price:             referencePrice,
      meli_subsidy_brl:  item.meli_subsidy_amount ?? 0,
      free_shipping:     false,
      config,
      token,
    })

    // 5. Cenarios
    const scenarios = this.buildScenarios(item, costBreakdown, config)

    // 6. Quantidade
    const qtyRec = this.recommendQuantity(item, salesData, campaignRow, config)

    // 7. Score
    const score = this.calculateScore({
      campaign:        campaignRow,
      item,
      salesData,
      stockDays:       this.estimateStockDays(salesData, item.product_id),
      scenarios,
      qtyRec,
    })

    // 8. Classifica
    const classification = this.classify(score, scenarios, qtyRec, config, salesData)

    // 9. Texto explicativo: tenta IA primeiro (respeita cap), fallback template
    const deterministicReasoning = this.buildDeterministicReasoning({
      item, campaign: campaignRow, scenarios, qtyRec, score, classification, salesData,
    })

    let reasoning = deterministicReasoning
    let aiUsed = false
    let aiCost = 0
    if (classification.type !== 'review_costs' && classification.type !== 'low_quality_listing') {
      // Tenta IA so pra casos onde reasoning enriquecido faz diferenca
      const aiOutput = await this.reasoning.generateReasoning({
        orgId:    item.organization_id,
        sellerId: item.seller_id,
        campaign: {
          name:                campaignRow.name,
          promotion_type:      campaignRow.ml_promotion_type,
          deadline_date:       campaignRow.deadline_date,
          has_subsidy_items:   campaignRow.has_subsidy_items ?? false,
          avg_meli_subsidy_pct:campaignRow.avg_meli_subsidy_pct,
        },
        item: {
          ml_item_id:       item.ml_item_id,
          original_price:   item.original_price,
          has_meli_subsidy: item.has_meli_subsidy,
          meli_percentage:  item.meli_percentage,
        },
        cost_breakdown: costBreakdown as unknown as Record<string, number>,
        scenarios:      scenarios as unknown as Parameters<typeof this.reasoning.generateReasoning>[0]['scenarios'],
        quantity_recommendation: {
          current_stock:       qtyRec.current_stock,
          avg_daily_sales:     qtyRec.avg_daily_sales,
          recommended_max_qty: qtyRec.recommended_max_qty,
          rupture_risk:        qtyRec.rupture_risk,
        },
        score:          { total: score.total, breakdown: score as unknown as Record<string, number> },
        classification: {
          type:     classification.type,
          strategy: classification.strategy,
          price:    classification.price,
        },
        sales_30d: salesData.last_30d,
      })
      if (aiOutput) {
        reasoning = aiOutput.text
        aiUsed = true
        aiCost = aiOutput.cost_usd
      }
    }

    // 10. Warnings
    const warnings = this.identifyWarnings({ item, scenarios, qtyRec })

    // 11. Save
    return this.saveRecommendation({
      item, campaign: campaignRow,
      cost_breakdown: costBreakdown,
      scenarios, qtyRec, score,
      classification, reasoning, warnings,
      generation_metadata: {
        engine_version:    'deterministic-v1',
        ai_reasoning_used: aiUsed,
        ai_cost_usd:       aiCost,
        generated_in_ms:   Date.now() - t0,
      },
    })
  }

  // ── Building blocks ─────────────────────────────────────────────

  private buildScenarios(item: CampaignItemRow, costs: CostBreakdown, config: CampaignsConfig): PriceScenarios {
    const original   = item.original_price ?? 0
    const minPrice   = item.min_discounted_price ?? original * 0.5
    const maxPrice   = item.max_discounted_price ?? original
    const subsidyAdj = item.meli_subsidy_amount ?? 0

    // break_even = total_costs (a esse preco, lucro = 0)
    const breakEven = costs.total_costs

    // Conservador: target_margin_pct
    const conservativePrice = Math.min(maxPrice, this.priceForMargin(costs, config.target_margin_pct))
    const conservative = this.buildScenario(conservativePrice, costs, original, 'low',
      `Preserva margem alvo de ${config.target_margin_pct}%`)

    // Competitivo: ML suggested OR meio termo
    const suggested = item.suggested_discounted_price
    const competitivePrice = suggested && suggested >= minPrice && suggested <= maxPrice
      ? suggested
      : (original * 0.85)
    const competitive = this.buildScenario(competitivePrice, costs, original, 'medium',
      suggested ? 'Preço sugerido pelo ML — equilíbrio margem × volume' : 'Desconto moderado de 15%')

    // Agressivo: clearance margin
    const aggressivePrice = Math.max(minPrice, this.priceForMargin(costs, config.clearance_min_margin_pct))
    const aggressive = this.buildScenario(aggressivePrice, costs, original, 'high',
      `Liquidação — margem mínima ${config.clearance_min_margin_pct}%`)

    void subsidyAdj
    return {
      conservative,
      competitive,
      aggressive,
      break_even: { price: round2(breakEven), rationale: 'Preço mínimo para não dar prejuízo' },
    }
  }

  private buildScenario(price: number, costs: CostBreakdown, original: number, vol: 'low' | 'medium' | 'high', rationale: string): PriceScenario {
    // Recalcula M.C. neste preco — total_costs ja inclui subsidio
    const newRevenue = price - costs.total_costs + (price - costs.cost_price > 0 ? 0 : 0)
    // simplification: total_costs ja considera subsidio constante. M.C. =
    // price - total_costs (sao os custos no preco "calibrado" inicialmente).
    // Pra ser preciso, deveriamos recalcular comissao no novo preco — em
    // produto onde a comissao varia muito, isso pode subestimar/superestimar.
    // Pra v1 assumimos comissao constante (ja arredondada na faixa de 50R$).
    const margin_brl = round2(price - costs.total_costs)
    const margin_pct = price > 0 ? round2((margin_brl / price) * 100) : 0
    const discount_pct = original > 0 ? round2(((original - price) / original) * 100) : 0
    void newRevenue
    return {
      price:           round2(price),
      discount_pct,
      margin_brl,
      margin_pct,
      expected_volume: vol,
      rationale,
    }
  }

  /** preco que produz margem alvo: P = total_costs / (1 - target_pct/100).
   *  Atencao: como total_costs depende do preco (comissao), eh aproximado. */
  private priceForMargin(costs: CostBreakdown, targetPct: number): number {
    return costs.total_costs / (1 - targetPct / 100)
  }

  private recommendQuantity(
    item:     CampaignItemRow,
    sales:    { last_30d: number; avg_daily: number; stock: number },
    campaign: { start_date: string | null; finish_date: string | null },
    config:   CampaignsConfig,
  ): QuantityRecommendation {
    const stock = sales.stock
    const avgDaily = sales.avg_daily
    const durationDays = campaign.start_date && campaign.finish_date
      ? Math.max(1, Math.round(
          (new Date(campaign.finish_date).getTime() - new Date(campaign.start_date).getTime()) / 86_400_000,
        ))
      : 7

    const expectedDemand = Math.ceil(avgDaily * durationDays * 1.5) // 1.5x boost de campanha
    const safetyStock = Math.ceil(avgDaily * config.safety_stock_days)

    const upperLimit = item.max_quantity ?? Infinity
    const recommendedRaw = Math.max(0, Math.min(
      stock - safetyStock,
      Math.ceil(expectedDemand * 1.2),
      upperLimit,
    ))
    const recommended = Math.floor(recommendedRaw)

    const stockAfter = stock - recommended
    const ruptureRisk: 'low' | 'medium' | 'high' =
      stockAfter < safetyStock         ? 'high'
      : stockAfter < safetyStock * 1.5 ? 'medium'
      : 'low'

    const rationale = recommended === 0
      ? 'Estoque insuficiente pra participar com segurança'
      : ruptureRisk === 'low'
        ? `Estoque suficiente (${stock} un) — recomendo até ${recommended} unidades`
        : ruptureRisk === 'medium'
          ? `Estoque limitado — risco de ruptura médio se vender ${recommended} un`
          : `ALTO risco de ruptura — considere pausar reposição antes`

    return {
      current_stock:           stock,
      avg_daily_sales:         round2(avgDaily),
      campaign_duration_days:  durationDays,
      expected_demand_during:  expectedDemand,
      safety_stock:            safetyStock,
      recommended_max_qty:     recommended,
      stock_after_campaign:    stockAfter,
      rupture_risk:            ruptureRisk,
      rationale,
    }
  }

  private calculateScore(ctx: {
    campaign: any
    item:     CampaignItemRow
    salesData: { last_30d: number; avg_daily: number; stock: number }
    stockDays: number
    scenarios: PriceScenarios
    qtyRec:    QuantityRecommendation
  }): ScoreBreakdown {
    const { campaign, salesData, stockDays, scenarios, qtyRec } = ctx
    const breakdown: ScoreBreakdown = {
      sales_potential: 0, subsidy: 0, final_margin: 0,
      stock_availability: 0, stock_turnover_need: 0, competitiveness: 5,
      risk_penalty: 0, total: 0,
    }

    // Sales potential (0-30)
    if (salesData.last_30d >= 50)      breakdown.sales_potential = 30
    else if (salesData.last_30d >= 20) breakdown.sales_potential = 22
    else if (salesData.last_30d >= 5)  breakdown.sales_potential = 14
    else                                breakdown.sales_potential = 5

    // Subsidy (0-20)
    if (campaign.has_subsidy_items) {
      const pct = campaign.avg_meli_subsidy_pct ?? 0
      if (pct >= 10)     breakdown.subsidy = 20
      else if (pct >= 5) breakdown.subsidy = 14
      else if (pct >  0) breakdown.subsidy = 7
    }

    // Final margin (0-20) — usa cenario competitivo
    const m = scenarios.competitive.margin_pct
    if (m >= 25)    breakdown.final_margin = 20
    else if (m >= 15) breakdown.final_margin = 14
    else if (m >= 5)  breakdown.final_margin = 7

    // Stock availability (0-10)
    breakdown.stock_availability =
      qtyRec.rupture_risk === 'low'    ? 10
      : qtyRec.rupture_risk === 'medium' ? 6
      : 2

    // Stock turnover need (0-10) — alto quando estoque parado
    if      (stockDays > 90) breakdown.stock_turnover_need = 10
    else if (stockDays > 60) breakdown.stock_turnover_need = 7
    else if (stockDays > 30) breakdown.stock_turnover_need = 4
    else                      breakdown.stock_turnover_need = 1

    // Penalidades
    let penalty = 0
    if (m < 0)                            penalty -= 30
    if (qtyRec.rupture_risk === 'high')   penalty -= 10
    if (qtyRec.recommended_max_qty === 0) penalty -= 20
    breakdown.risk_penalty = penalty

    breakdown.total = Math.max(0, Math.min(100,
      breakdown.sales_potential
      + breakdown.subsidy
      + breakdown.final_margin
      + breakdown.stock_availability
      + breakdown.stock_turnover_need
      + breakdown.competitiveness
      + breakdown.risk_penalty,
    ))
    return breakdown
  }

  private classify(
    score:     ScoreBreakdown,
    scenarios: PriceScenarios,
    qtyRec:    QuantityRecommendation,
    config:    CampaignsConfig,
    salesData: { last_30d: number; avg_daily: number; stock: number },
  ): ClassificationResult {
    const m = scenarios.competitive.margin_pct

    if (qtyRec.recommended_max_qty === 0) {
      return { type: 'skip', reason: 'no_stock', strategy: null, price: null }
    }

    if (m < 0) {
      return { type: 'skip', reason: 'margin_negative', strategy: null, price: null }
    }

    // Recomendado: score alto + margem boa
    if (score.total >= 70 && m >= config.target_margin_pct) {
      return {
        type:     'recommended',
        reason:   'high_score_good_margin',
        strategy: 'competitive',
        price:    scenarios.competitive.price,
      }
    }

    // Cautela: score medio + margem aceitavel
    if (score.total >= 50 && m >= config.min_acceptable_margin_pct) {
      return {
        type:     'recommended_caution',
        reason:   'medium_score',
        strategy: 'conservative',
        price:    scenarios.conservative.price,
      }
    }

    // Liquidacao: estoque parado + margem clearance OK
    const stockDays = salesData.avg_daily > 0 ? salesData.stock / salesData.avg_daily : 999
    if (stockDays > 60 && m >= config.clearance_min_margin_pct) {
      return {
        type:     'clearance_only',
        reason:   'high_stock_low_turnover',
        strategy: 'aggressive',
        price:    scenarios.aggressive.price,
      }
    }

    return { type: 'skip', reason: 'low_score_or_margin', strategy: null, price: null }
  }

  private buildDeterministicReasoning(ctx: {
    item:           CampaignItemRow
    campaign:       any
    scenarios:      PriceScenarios
    qtyRec:         QuantityRecommendation
    score:          ScoreBreakdown
    classification: ClassificationResult
    salesData:      { last_30d: number; avg_daily: number; stock: number }
  }): string {
    const { campaign, scenarios, qtyRec, score, classification, salesData } = ctx

    const verdicts: Record<string, string> = {
      recommended:         '✅ Recomendado participar.',
      recommended_caution: '⚠️ Participar com cautela.',
      clearance_only:      '♻️ Apenas para giro de estoque parado.',
      skip:                '❌ Não recomendado participar.',
      review_costs:        '📋 Revisar dados antes de participar.',
      low_quality_listing: '🔧 Corrigir qualidade do anúncio antes.',
    }

    const parts: string[] = [verdicts[classification.type] ?? '—']

    // Score + margem
    if (classification.type !== 'review_costs' && classification.type !== 'low_quality_listing') {
      parts.push(`Score ${score.total}/100, M.C. competitiva ${scenarios.competitive.margin_pct.toFixed(1)}%.`)
    }

    // Subsidio
    if (campaign.has_subsidy_items && campaign.avg_meli_subsidy_pct > 0) {
      parts.push(`ML reduz ~${campaign.avg_meli_subsidy_pct.toFixed(1)}% de tarifa por venda.`)
    }

    // Estoque
    if (qtyRec.rupture_risk === 'high') {
      parts.push(`Atenção: alto risco de ruptura no estoque.`)
    } else if (qtyRec.rupture_risk === 'medium') {
      parts.push(`Estoque limitado (${salesData.stock} un).`)
    }

    // Vendas
    if (salesData.last_30d === 0) {
      parts.push('Sem histórico de vendas nos últimos 30d.')
    } else if (salesData.last_30d >= 50) {
      parts.push(`Produto vende bem (${salesData.last_30d} un/30d).`)
    }

    // Acao concreta
    if (classification.price != null && qtyRec.recommended_max_qty > 0) {
      parts.push(`Sugerimos preço R$ ${classification.price.toFixed(2)} com até ${qtyRec.recommended_max_qty} unidades.`)
    }

    return parts.join(' ')
  }

  private identifyWarnings(ctx: {
    item:      CampaignItemRow
    scenarios: PriceScenarios
    qtyRec:    QuantityRecommendation
  }): Array<{ code: string; severity: 'low' | 'medium' | 'high'; message: string }> {
    const w: Array<{ code: string; severity: 'low' | 'medium' | 'high'; message: string }> = []
    const m = ctx.scenarios.competitive.margin_pct
    if (m < 0) w.push({ code: 'negative_margin',     severity: 'high',   message: `Margem negativa em preço competitivo (${m.toFixed(1)}%)` })
    else if (m < 5) w.push({ code: 'thin_margin',    severity: 'medium', message: `Margem muito apertada (${m.toFixed(1)}%)` })
    if (ctx.qtyRec.rupture_risk === 'high')  w.push({ code: 'rupture_risk_high',  severity: 'high',   message: 'Alto risco de ruptura — revisar estoque' })
    if (ctx.qtyRec.recommended_max_qty === 0) w.push({ code: 'no_stock',          severity: 'high',   message: 'Estoque insuficiente pra participar' })
    return w
  }

  // ── Persistence ──────────────────────────────────────────────────

  private async saveReviewCosts(item: CampaignItemRow, campaign: any, t0: number) {
    return this.upsertPending({
      organization_id:        item.organization_id,
      seller_id:              item.seller_id,
      campaign_item_id:       item.id,
      product_id:             item.product_id,
      cost_breakdown:         {},
      scenarios:              {},
      quantity_recommendation:{},
      opportunity_score:      0,
      score_breakdown:        {},
      recommendation:         'review_costs',
      recommendation_reason:  '📋 Antes de participar dessa campanha, complete os dados do produto: ' +
                              (item.health_warnings ?? []).map((w: any) => w.message).join('; '),
      recommended_strategy:   null,
      recommended_price:      null,
      recommended_quantity:   null,
      warnings:               item.health_warnings ?? [],
      expires_at:             campaign.deadline_date,
      generation_metadata:    { engine_version: 'deterministic-v1', ai_reasoning_used: false, ai_cost_usd: 0, generated_in_ms: Date.now() - t0 },
    })
  }

  private async saveLowQuality(item: CampaignItemRow, campaign: any, qScore: number, t0: number) {
    return this.upsertPending({
      organization_id:        item.organization_id,
      seller_id:              item.seller_id,
      campaign_item_id:       item.id,
      product_id:             item.product_id,
      cost_breakdown:         {},
      scenarios:              {},
      quantity_recommendation:{},
      opportunity_score:      qScore,
      score_breakdown:        {},
      recommendation:         'low_quality_listing',
      recommendation_reason:  `🔧 Anúncio com qualidade baixa (score ${qScore}/100). Corrigir ficha técnica e voltar — ` +
                              `promover anúncio incompleto reduz conversão. Revisar no Quality Center.`,
      recommended_strategy:   null,
      recommended_price:      null,
      recommended_quantity:   null,
      warnings:               [{ code: 'low_quality_listing', severity: 'high', message: `Score ML ${qScore}/100 abaixo do mínimo 60` }],
      expires_at:             campaign.deadline_date,
      generation_metadata:    { engine_version: 'deterministic-v1', ai_reasoning_used: false, ai_cost_usd: 0, generated_in_ms: Date.now() - t0 },
    })
  }

  private async saveRecommendation(opts: {
    item:                  CampaignItemRow
    campaign:              any
    cost_breakdown:        CostBreakdown
    scenarios:             PriceScenarios
    qtyRec:                QuantityRecommendation
    score:                 ScoreBreakdown
    classification:        ClassificationResult
    reasoning:             string
    warnings:              Array<{ code: string; severity: 'low' | 'medium' | 'high'; message: string }>
    generation_metadata:   Record<string, unknown>
  }) {
    const { item, campaign, cost_breakdown, scenarios, qtyRec, score, classification, reasoning, warnings, generation_metadata } = opts
    return this.upsertPending({
      organization_id:        item.organization_id,
      seller_id:              item.seller_id,
      campaign_item_id:       item.id,
      product_id:             item.product_id,
      cost_breakdown,
      scenarios,
      quantity_recommendation: qtyRec,
      opportunity_score:      score.total,
      score_breakdown:        score,
      recommendation:         classification.type,
      recommendation_reason:  reasoning,
      recommended_strategy:   classification.strategy,
      recommended_price:      classification.price,
      recommended_quantity:   qtyRec.recommended_max_qty,
      warnings,
      expires_at:             campaign.deadline_date,
      generation_metadata,
    })
  }

  /** Upsert "pending" row — substitui qualquer pending anterior do mesmo item. */
  private async upsertPending(payload: Record<string, unknown>): Promise<{ id: string }> {
    // Primeiro deleta pending anterior (se houver)
    await supabaseAdmin
      .from('ml_campaign_recommendations')
      .delete()
      .eq('campaign_item_id', payload.campaign_item_id as string)
      .eq('status', 'pending')

    const { data, error } = await supabaseAdmin
      .from('ml_campaign_recommendations')
      .insert({ ...payload, status: 'pending' })
      .select('id')
      .single()
    if (error || !data) throw new BadRequestException(`save reco falhou: ${error?.message}`)
    return data as { id: string }
  }

  // ── Helpers de contexto ─────────────────────────────────────────

  private async getConfig(orgId: string, sellerId: number): Promise<CampaignsConfig> {
    const { data } = await supabaseAdmin
      .from('ml_campaigns_config')
      .select('*')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .maybeSingle()

    if (data) return data as unknown as CampaignsConfig

    // Defaults se nao tiver ainda
    return {
      min_acceptable_margin_pct:     15,
      target_margin_pct:             25,
      clearance_min_margin_pct:      5,
      safety_stock_days:             7,
      high_stock_threshold_days:     90,
      min_stock_to_participate:      3,
      quality_gate_enabled:          true,
      quality_gate_min_score:        60,
      default_packaging_cost:        0,
      default_operational_cost_pct:  0,
      ai_daily_cap_usd:              10,
      ai_alert_at_pct:               80,
      ai_reasoning_enabled:          true,
      auto_suggest_on_new_candidate: true,
      daily_analysis_enabled:        true,
      auto_approve_enabled:          false,
      auto_approve_score_above:      85,
    }
  }

  private async getQualityScore(orgId: string, mlItemId: string, sellerId: number): Promise<number | null> {
    const { data } = await supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_score')
      .eq('organization_id', orgId)
      .eq('ml_item_id',      mlItemId)
      .eq('seller_id',       sellerId)
      .maybeSingle()
    return (data as { ml_score: number | null } | null)?.ml_score ?? null
  }

  private async getSalesData(productId: string | null, _days: number): Promise<{ last_30d: number; avg_daily: number; stock: number }> {
    if (!productId) return { last_30d: 0, avg_daily: 0, stock: 0 }
    const { data } = await supabaseAdmin
      .from('products')
      .select('stock')
      .eq('id', productId)
      .maybeSingle()
    const stock = (data as { stock: number | null } | null)?.stock ?? 0

    // Tenta product_sales_monthly pra ultimo mes
    const { data: sales } = await supabaseAdmin
      .from('product_sales_monthly')
      .select('quantity')
      .eq('product_id', productId)
      .order('year_month', { ascending: false })
      .limit(1)
      .maybeSingle()
    const last30 = (sales as { quantity: number | null } | null)?.quantity ?? 0

    return { last_30d: last30, avg_daily: last30 / 30, stock }
  }

  private estimateStockDays(sales: { avg_daily: number; stock: number }, _productId: string | null): number {
    return sales.avg_daily > 0 ? sales.stock / sales.avg_daily : 999
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
