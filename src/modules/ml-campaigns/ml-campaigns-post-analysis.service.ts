/** Post-Analysis Engine — F8 Camada 4.
 *
 *  Quando uma campanha encerra:
 *  1. Define janela antes (30d antes do start) e depois (30d apos finish)
 *  2. Pra cada item que participou (audit_log com applied_successfully):
 *     - Soma orders.units / revenue / margin nas 3 janelas (orders.sold_at)
 *     - Identifica rupture (item teve sold_at sem stock disponivel?)
 *  3. Calcula lift % (durante / antes - 1) em units e revenue
 *  4. Calcula ROI: incremental_revenue + subsidio_recebido - desconto_total
 *  5. Identifica best/worst performers (top 10 / bottom 10)
 *  6. Gera ai_summary via reasoning service (1 chamada IA pela campanha)
 *  7. Atualiza learnings agregados por (org, seller, type, domain)
 *
 *  Roda automaticamente via cron 1x/dia (procura campanhas finished sem
 *  post_analysis), ou manual via POST /post-analysis/generate/:campaignId.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

interface SalesAggregate {
  units:       number
  revenue:     number
  margin_brl:  number
  margin_pct:  number   // weighted avg
}

interface PerformerEntry {
  ml_item_id:    string
  product_id:    string | null
  units_during:  number
  revenue_during:number
  margin_brl:    number
  margin_pct:    number
  units_lift_pct?: number
}

@Injectable()
export class MlCampaignsPostAnalysisService {
  private readonly logger = new Logger(MlCampaignsPostAnalysisService.name)

  constructor(private readonly llm: LlmService) {}

  // ── Cron: 1x/dia procura campanhas pra analisar ────────────────

  @Cron('0 7 * * *', { name: 'ml-campaigns-post-analysis', timeZone: 'America/Sao_Paulo' })
  async dailyAutoAnalysis(): Promise<void> {
    if (process.env.DISABLE_ML_CAMPAIGNS_WORKER === 'true') return

    // Encontra campanhas 'finished' sem post_analysis
    const { data: campaigns } = await supabaseAdmin
      .from('ml_campaigns')
      .select('id, organization_id, seller_id, finish_date')
      .eq('status', 'finished')
      .not('finish_date', 'is', null)

    if (!campaigns || campaigns.length === 0) return

    let analyzed = 0
    for (const c of (campaigns as Array<{ id: string; organization_id: string; seller_id: number; finish_date: string }>)) {
      // So analisa se passou pelo menos 7 dias do fim (deixa orders pos-campanha aparecerem)
      const daysSinceFinish = (Date.now() - new Date(c.finish_date).getTime()) / 86_400_000
      if (daysSinceFinish < 7) continue

      // Pula se ja analisada
      const { data: existing } = await supabaseAdmin
        .from('ml_campaign_post_analysis')
        .select('id')
        .eq('campaign_id', c.id)
        .maybeSingle()
      if (existing) continue

      try {
        await this.generateAnalysis(c.id)
        analyzed++
      } catch (e) {
        this.logger.warn(`[post-analysis] falhou pra ${c.id}: ${(e as Error).message}`)
      }
    }
    if (analyzed > 0) {
      this.logger.log(`[post-analysis] cron diario: ${analyzed} campanhas analisadas`)
    }
  }

  // ── Generate analysis pra 1 campanha ───────────────────────────

  async generateAnalysis(campaignId: string): Promise<{ id: string }> {
    const { data: campaign } = await supabaseAdmin
      .from('ml_campaigns')
      .select('*')
      .eq('id', campaignId)
      .maybeSingle()
    if (!campaign) throw new BadRequestException('campanha nao encontrada')
    const c = campaign as any

    if (!c.start_date || !c.finish_date) {
      throw new BadRequestException('campanha sem start_date/finish_date — nao da pra calcular janelas')
    }

    const start  = new Date(c.start_date)
    const finish = new Date(c.finish_date)
    const before30d = new Date(start.getTime() - 30 * 86_400_000)
    const after30d  = new Date(finish.getTime() + 30 * 86_400_000)

    // 1. Items que aplicaram (sucesso no audit_log com action=join_campaign)
    const { data: applied } = await supabaseAdmin
      .from('ml_campaign_audit_log')
      .select('ml_item_id, product_id, ml_offer_id_after')
      .eq('campaign_id', campaignId)
      .eq('action', 'join_campaign')
      .eq('applied_successfully', true)
    const appliedItems = (applied ?? []) as Array<{ ml_item_id: string; product_id: string | null; ml_offer_id_after: string | null }>
    const distinctItems = [...new Map(appliedItems.map(a => [a.ml_item_id, a])).values()]

    if (distinctItems.length === 0) {
      // Nenhum item aplicado — gera analysis "vazia"
      return this.saveEmptyAnalysis(c, before30d, after30d)
    }

    // 2. Pra cada item, busca orders nas 3 janelas
    const performers: PerformerEntry[] = []
    let totalBefore  = { units: 0, revenue: 0, margin_brl: 0, margin_pct_sum: 0, w_count: 0 }
    let totalDuring  = { units: 0, revenue: 0, margin_brl: 0, margin_pct_sum: 0, w_count: 0 }
    let totalAfter   = { units: 0, revenue: 0, margin_brl: 0, margin_pct_sum: 0, w_count: 0 }

    for (const item of distinctItems) {
      const before = await this.salesInWindow(c.organization_id, c.seller_id, item.ml_item_id, before30d, start)
      const during = await this.salesInWindow(c.organization_id, c.seller_id, item.ml_item_id, start, finish)
      const after  = await this.salesInWindow(c.organization_id, c.seller_id, item.ml_item_id, finish, after30d)

      totalBefore.units += before.units; totalBefore.revenue += before.revenue; totalBefore.margin_brl += before.margin_brl
      if (before.units > 0) { totalBefore.margin_pct_sum += before.margin_pct * before.units; totalBefore.w_count += before.units }
      totalDuring.units += during.units; totalDuring.revenue += during.revenue; totalDuring.margin_brl += during.margin_brl
      if (during.units > 0) { totalDuring.margin_pct_sum += during.margin_pct * during.units; totalDuring.w_count += during.units }
      totalAfter.units += after.units; totalAfter.revenue += after.revenue; totalAfter.margin_brl += after.margin_brl
      if (after.units > 0) { totalAfter.margin_pct_sum += after.margin_pct * after.units; totalAfter.w_count += after.units }

      const liftPct = before.units > 0 ? ((during.units / before.units) - 1) * 100 : during.units > 0 ? 100 : 0
      performers.push({
        ml_item_id:     item.ml_item_id,
        product_id:     item.product_id,
        units_during:   during.units,
        revenue_during: during.revenue,
        margin_brl:     during.margin_brl,
        margin_pct:     during.margin_pct,
        units_lift_pct: round2(liftPct),
      })
    }

    // 3. Lift agregado
    const unitsLift   = totalBefore.units > 0 ? round2(((totalDuring.units / totalBefore.units) - 1) * 100) : null
    const revenueLift = totalBefore.revenue > 0 ? round2(((totalDuring.revenue / totalBefore.revenue) - 1) * 100) : null
    const avgMarginBefore = totalBefore.w_count > 0 ? round2(totalBefore.margin_pct_sum / totalBefore.w_count) : null
    const avgMarginDuring = totalDuring.w_count > 0 ? round2(totalDuring.margin_pct_sum / totalDuring.w_count) : null
    const avgMarginAfter  = totalAfter.w_count  > 0 ? round2(totalAfter.margin_pct_sum  / totalAfter.w_count)  : null

    // 4. Subsidio MELI total recebido (somatoria do meli_subsidy_amount × units durante)
    const { data: itemsWithSubsidy } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('meli_subsidy_amount, ml_item_id')
      .eq('campaign_id', campaignId)
      .eq('has_meli_subsidy', true)
    let totalSubsidyReceived = 0
    for (const sub of (itemsWithSubsidy ?? []) as Array<{ meli_subsidy_amount: number | null; ml_item_id: string }>) {
      const perf = performers.find(p => p.ml_item_id === sub.ml_item_id)
      if (perf && sub.meli_subsidy_amount) {
        totalSubsidyReceived += (sub.meli_subsidy_amount ?? 0) * perf.units_during
      }
    }

    // 5. ROI: incremental revenue (vs cenario sem campanha) + subsidio - desconto total
    // Heuristica: cenario "sem campanha" = vendas medias before extrapoladas pra duracao da campanha
    const durationDays = Math.max(1, Math.round((finish.getTime() - start.getTime()) / 86_400_000))
    const beforeWindowDays = 30
    const expectedNoCampaignUnits = Math.round((totalBefore.units / beforeWindowDays) * durationDays)
    const incrementalUnits = Math.max(0, totalDuring.units - expectedNoCampaignUnits)
    const avgPriceDuring = totalDuring.units > 0 ? totalDuring.revenue / totalDuring.units : 0
    const incrementalRevenue = round2(incrementalUnits * avgPriceDuring)

    // Custo do desconto: somatoria de (original_price - sale_price) × units sold pra cada item
    const discountCost = await this.calculateDiscountCost(campaignId, distinctItems.map(i => i.ml_item_id), start, finish, c.organization_id, c.seller_id)
    const roi = round2(incrementalRevenue + totalSubsidyReceived - discountCost)
    const roiPct = discountCost > 0 ? round2((roi / discountCost) * 100) : null

    // 6. Best/worst performers
    const sortedByUnits = [...performers].sort((a, b) => b.units_during - a.units_during)
    const bestPerformers  = sortedByUnits.slice(0, 10)
    const worstPerformers = sortedByUnits.filter(p => p.margin_brl < 0 || p.units_during === 0).slice(0, 10)

    // 7. AI summary (best effort — se falhar, deixa null)
    const aiSummary = await this.generateAiSummary({
      campaign:       c,
      participated:   distinctItems.length,
      unitsLift, revenueLift,
      avgMarginBefore, avgMarginDuring,
      totalSubsidyReceived,
      roi, roiPct,
      bestPerformers, worstPerformers,
    }).catch(() => null)

    // 8. Recomendacoes pra proxima
    const recommendedNext    = bestPerformers.filter(p => p.margin_pct >= 15).map(p => ({ product_id: p.product_id, ml_item_id: p.ml_item_id }))
    const notRecommendedNext = worstPerformers.map(p => ({ product_id: p.product_id, ml_item_id: p.ml_item_id }))

    // 9. Insights
    const insights = this.buildInsights({
      unitsLift, revenueLift, avgMarginDuring, avgMarginBefore, totalSubsidyReceived, roi, roiPct,
    })

    // 10. Save
    const { data: saved, error } = await supabaseAdmin
      .from('ml_campaign_post_analysis')
      .upsert({
        organization_id:             c.organization_id,
        seller_id:                   c.seller_id,
        campaign_id:                 campaignId,
        campaign_start:              start.toISOString(),
        campaign_end:                finish.toISOString(),
        before_window_start:         before30d.toISOString(),
        after_window_end:            after30d.toISOString(),
        participated_items_count:    distinctItems.length,
        applied_items_count:         distinctItems.length,
        approved_items_count:        distinctItems.length,
        units_sold_before:           totalBefore.units,
        units_sold_during:           totalDuring.units,
        units_sold_after:            totalAfter.units,
        units_sold_lift_pct:         unitsLift,
        revenue_before:              round2(totalBefore.revenue),
        revenue_during:              round2(totalDuring.revenue),
        revenue_after:               round2(totalAfter.revenue),
        revenue_lift_pct:            revenueLift,
        avg_margin_before_pct:       avgMarginBefore,
        avg_margin_during_pct:       avgMarginDuring,
        avg_margin_after_pct:        avgMarginAfter,
        total_margin_brl_during:     round2(totalDuring.margin_brl),
        total_meli_subsidy_received: round2(totalSubsidyReceived),
        incremental_revenue:         incrementalRevenue,
        incremental_units:           incrementalUnits,
        campaign_roi_brl:            roi,
        campaign_roi_pct:            roiPct,
        best_performers:             bestPerformers as unknown,
        worst_performers:            worstPerformers as unknown,
        rupture_items:               [] as unknown,
        ai_summary:                  aiSummary,
        recommended_for_next_time:   recommendedNext as unknown,
        not_recommended_for_next_time: notRecommendedNext as unknown,
        insights:                    insights as unknown,
        generated_at:                new Date().toISOString(),
      }, { onConflict: 'organization_id,seller_id,campaign_id' })
      .select('id')
      .single()
    if (error || !saved) throw new BadRequestException(`save analysis falhou: ${error?.message}`)

    // 11. Atualiza learnings agregados
    await this.updateLearnings(c, performers, roiPct, unitsLift, revenueLift)

    return { id: (saved as { id: string }).id }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private async salesInWindow(
    orgId:    string,
    sellerId: number,
    mlItemId: string,
    from:     Date,
    to:       Date,
  ): Promise<SalesAggregate> {
    const { data } = await supabaseAdmin
      .from('orders')
      .select('quantity, sale_price, contribution_margin, contribution_margin_pct')
      .eq('organization_id', orgId)
      .eq('marketplace_listing_id', mlItemId)
      .eq('platform', 'ML')
      .gte('sold_at', from.toISOString())
      .lt('sold_at', to.toISOString())
      .in('status', ['paid', 'completed', 'delivered'])

    const arr = (data ?? []) as Array<{
      quantity: number | null
      sale_price: number | null
      contribution_margin: number | null
      contribution_margin_pct: number | null
    }>

    let units = 0, revenue = 0, marginBrl = 0
    let pctSum = 0, pctCount = 0
    for (const o of arr) {
      const qty = o.quantity ?? 1
      units += qty
      revenue += (o.sale_price ?? 0) * qty
      if (o.contribution_margin != null) marginBrl += o.contribution_margin
      if (o.contribution_margin_pct != null) { pctSum += o.contribution_margin_pct; pctCount++ }
    }
    return {
      units,
      revenue,
      margin_brl: marginBrl,
      margin_pct: pctCount > 0 ? pctSum / pctCount : 0,
    }
  }

  private async calculateDiscountCost(
    campaignId: string,
    mlItemIds:  string[],
    from:       Date,
    to:         Date,
    orgId:      string,
    sellerId:   number,
  ): Promise<number> {
    if (mlItemIds.length === 0) return 0

    // Busca orders no periodo + original_price do ml_campaign_items
    const { data: items } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('ml_item_id, original_price, current_price')
      .eq('campaign_id', campaignId)
      .in('ml_item_id', mlItemIds)
    const priceMap = new Map<string, { original: number; current: number }>()
    for (const it of (items ?? []) as Array<{ ml_item_id: string; original_price: number | null; current_price: number | null }>) {
      priceMap.set(it.ml_item_id, {
        original: it.original_price ?? 0,
        current:  it.current_price ?? it.original_price ?? 0,
      })
    }

    let totalDiscount = 0
    for (const itemId of mlItemIds) {
      const prices = priceMap.get(itemId)
      if (!prices) continue
      const discount = prices.original - prices.current
      if (discount <= 0) continue

      const sales = await this.salesInWindow(orgId, sellerId, itemId, from, to)
      totalDiscount += discount * sales.units
    }
    return round2(totalDiscount)
  }

  private async generateAiSummary(ctx: {
    campaign:                 any
    participated:             number
    unitsLift:                number | null
    revenueLift:              number | null
    avgMarginBefore:          number | null
    avgMarginDuring:          number | null
    totalSubsidyReceived:     number
    roi:                      number
    roiPct:                   number | null
    bestPerformers:           PerformerEntry[]
    worstPerformers:          PerformerEntry[]
  }): Promise<string | null> {
    const { campaign: c } = ctx
    try {
      const result = await this.llm.generateText({
        orgId:        c.organization_id,
        feature:      'ml_campaign_reasoning',
        systemPrompt: 'Você é analista comercial sênior em e-commerce. Análises sucintas, técnicas, sem jargão.',
        userPrompt:   `Analise o resultado pós-campanha em PT-BR (max 200 palavras).

CAMPANHA: ${c.name ?? c.ml_campaign_id} (${c.ml_promotion_type})
Período: ${c.start_date} a ${c.finish_date}

PARTICIPACAO: ${ctx.participated} anuncios

VENDAS:
- Lift de unidades: ${ctx.unitsLift?.toFixed(1) ?? '—'}%
- Lift de receita: ${ctx.revenueLift?.toFixed(1) ?? '—'}%

MARGEM:
- Antes: ${ctx.avgMarginBefore?.toFixed(1) ?? '—'}%
- Durante: ${ctx.avgMarginDuring?.toFixed(1) ?? '—'}%
- Diferenca: ${ctx.avgMarginBefore != null && ctx.avgMarginDuring != null ? (ctx.avgMarginDuring - ctx.avgMarginBefore).toFixed(1) : '—'}pp

SUBSIDIO MELI RECEBIDO: R$ ${ctx.totalSubsidyReceived.toFixed(2)}

ROI: R$ ${ctx.roi.toFixed(2)} (${ctx.roiPct?.toFixed(1) ?? '—'}%)

TOP 3 PERFORMERS: ${ctx.bestPerformers.slice(0, 3).map(p => `${p.ml_item_id} (${p.units_during}un)`).join(', ')}

Estrutura da resposta:
1. Veredito: campanha valeu a pena? (1 frase)
2. Driver principal do resultado (subsidio, lift de demanda, margem, etc).
3. Aprendizado pra proxima: o que fazer diferente.
4. Recomendacao concreta de produtos/estrategia pra repetir ou evitar.

Sem markdown, sem bullets, sem floreio.`,
        maxTokens:   400,
        temperature: 0.4,
      })
      return result.text.trim()
    } catch {
      return null
    }
  }

  private buildInsights(ctx: {
    unitsLift: number | null
    revenueLift: number | null
    avgMarginDuring: number | null
    avgMarginBefore: number | null
    totalSubsidyReceived: number
    roi: number
    roiPct: number | null
  }): Array<{ type: string; message: string }> {
    const out: Array<{ type: string; message: string }> = []
    if (ctx.unitsLift != null && ctx.unitsLift >= 50) {
      out.push({ type: 'high_lift', message: `Lift de ${ctx.unitsLift.toFixed(0)}% em unidades — campanha gerou demanda real` })
    }
    if (ctx.unitsLift != null && ctx.unitsLift < -10) {
      out.push({ type: 'negative_lift', message: `Vendas caíram ${Math.abs(ctx.unitsLift).toFixed(0)}% durante campanha — desconto pode não ter atraído público` })
    }
    if (ctx.totalSubsidyReceived > 0) {
      out.push({ type: 'subsidy_recouped', message: `R$ ${ctx.totalSubsidyReceived.toFixed(2)} de subsídio ML recebido` })
    }
    if (ctx.avgMarginDuring != null && ctx.avgMarginBefore != null) {
      const diff = ctx.avgMarginDuring - ctx.avgMarginBefore
      if (diff < -10) {
        out.push({ type: 'margin_compression', message: `Margem caiu ${Math.abs(diff).toFixed(1)}pp durante campanha` })
      }
    }
    if (ctx.roiPct != null && ctx.roiPct < 0) {
      out.push({ type: 'negative_roi', message: `ROI negativo: ${ctx.roiPct.toFixed(1)}% — desconto não compensou aumento de volume` })
    }
    if (ctx.roiPct != null && ctx.roiPct >= 50) {
      out.push({ type: 'great_roi', message: `ROI excelente: +${ctx.roiPct.toFixed(0)}% — repetir formato` })
    }
    return out
  }

  private async saveEmptyAnalysis(c: any, before: Date, after: Date): Promise<{ id: string }> {
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_post_analysis')
      .upsert({
        organization_id:    c.organization_id,
        seller_id:          c.seller_id,
        campaign_id:        c.id,
        campaign_start:     c.start_date,
        campaign_end:       c.finish_date,
        before_window_start:before.toISOString(),
        after_window_end:   after.toISOString(),
        participated_items_count: 0,
        applied_items_count:      0,
        approved_items_count:     0,
        ai_summary: 'Campanha encerrou sem nenhum item participante — nada pra analisar.',
      }, { onConflict: 'organization_id,seller_id,campaign_id' })
      .select('id')
      .single()
    if (error) throw new BadRequestException(`save empty analysis: ${error.message}`)
    return data as { id: string }
  }

  private async updateLearnings(
    c:          any,
    performers: PerformerEntry[],
    roiPct:     number | null,
    unitsLift:  number | null,
    revenueLift:number | null,
  ): Promise<void> {
    if (performers.length === 0) return

    // Agrega por tipo de campanha (sem domain breakdown na v1)
    const successCount = performers.filter(p => p.margin_pct >= 15).length
    const successRate  = performers.length > 0 ? successCount / performers.length : 0

    // Score adjustment: se sucesso > 70% e roi > 0 → +10, se < 30% e roi < 0 → -15
    let adjustment = 0
    if (successRate > 0.7 && (roiPct ?? 0) > 0)  adjustment = 10
    if (successRate < 0.3 && (roiPct ?? 0) < 0)  adjustment = -15

    // Upsert learning aggregado pra esse type
    const { data: existing } = await supabaseAdmin
      .from('ml_campaign_learnings')
      .select('id, campaigns_analyzed, avg_units_lift_pct, avg_revenue_lift_pct, avg_roi_pct, success_rate')
      .eq('organization_id', c.organization_id)
      .eq('seller_id',       c.seller_id)
      .eq('ml_promotion_type', c.ml_promotion_type)
      .is('ml_domain_id',    null)
      .maybeSingle()

    if (existing) {
      const prev = existing as { id: string; campaigns_analyzed: number; avg_units_lift_pct: number | null; avg_revenue_lift_pct: number | null; avg_roi_pct: number | null; success_rate: number | null }
      const n = prev.campaigns_analyzed + 1
      const newAvg = (prevAvg: number | null, newVal: number | null) =>
        newVal == null ? prevAvg : prevAvg == null ? newVal : ((prevAvg * (n - 1)) + newVal) / n

      await supabaseAdmin
        .from('ml_campaign_learnings')
        .update({
          campaigns_analyzed:           n,
          avg_units_lift_pct:           newAvg(prev.avg_units_lift_pct, unitsLift),
          avg_revenue_lift_pct:         newAvg(prev.avg_revenue_lift_pct, revenueLift),
          avg_roi_pct:                  newAvg(prev.avg_roi_pct, roiPct),
          success_rate:                 ((prev.success_rate ?? 0) * (n - 1) + successRate) / n,
          recommended_score_adjustment: adjustment,
          last_updated_at:              new Date().toISOString(),
        })
        .eq('id', prev.id)
    } else {
      await supabaseAdmin
        .from('ml_campaign_learnings')
        .insert({
          organization_id:              c.organization_id,
          seller_id:                    c.seller_id,
          ml_promotion_type:            c.ml_promotion_type,
          campaigns_analyzed:           1,
          avg_units_lift_pct:           unitsLift,
          avg_revenue_lift_pct:         revenueLift,
          avg_roi_pct:                  roiPct,
          success_rate:                 successRate,
          recommended_score_adjustment: adjustment,
        })
    }
  }

  // ── Read queries ───────────────────────────────────────────────

  async listAnalyses(orgId: string, sellerId?: number, limit = 50) {
    let q = supabaseAdmin
      .from('ml_campaign_post_analysis')
      .select('*, ml_campaigns!inner(name, ml_promotion_type, status)')
      .eq('organization_id', orgId)
      .order('generated_at', { ascending: false })
      .limit(limit)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`listAnalyses: ${error.message}`)
    return data ?? []
  }

  async getAnalysis(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_post_analysis')
      .select('*, ml_campaigns(name, ml_promotion_type, status, ml_campaign_id, deadline_date)')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new BadRequestException(`getAnalysis: ${error.message}`)
    return data
  }

  async getAnalysisByCampaign(orgId: string, campaignId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_campaign_post_analysis')
      .select('*')
      .eq('organization_id', orgId)
      .eq('campaign_id', campaignId)
      .maybeSingle()
    if (error) throw new BadRequestException(`getAnalysisByCampaign: ${error.message}`)
    return data
  }

  async listLearnings(orgId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_campaign_learnings')
      .select('*')
      .eq('organization_id', orgId)
      .order('campaigns_analyzed', { ascending: false })
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`listLearnings: ${error.message}`)
    return data ?? []
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
