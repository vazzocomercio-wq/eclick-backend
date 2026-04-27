import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { AdsAiService } from '../ads-ai.service'
import { ContextBuilderService, CampaignContext } from './context-builder.service'

type Severity = 'low' | 'medium' | 'high' | 'critical'
interface DraftInsight {
  type: string
  severity: Severity
  campaign_id: string | null
  campaign_name: string | null
  title: string
  description: string
  recommendation: string
  estimated_impact: string | null
  data_snapshot: Record<string, unknown>
}

@Injectable()
export class InsightDetectorService {
  private readonly logger = new Logger(InsightDetectorService.name)

  constructor(
    private readonly settings: AdsAiService,
    private readonly ctx: ContextBuilderService,
  ) {}

  /** Hourly cron — picks up every org with auto_detect_enabled and runs
   * the detection rules for that org. */
  @Cron(CronExpression.EVERY_HOUR)
  async tick() {
    try {
      const { data: settings } = await supabaseAdmin
        .from('ads_ai_settings')
        .select('organization_id')
        .eq('auto_detect_enabled', true)

      if (!settings?.length) return

      let totalInsights = 0
      for (const s of settings) {
        try {
          const found = await this.detect(s.organization_id as string)
          totalInsights += found
        } catch (e: unknown) {
          const err = e as { message?: string }
          this.logger.warn(`[ads-ai.detect.cron] org=${s.organization_id}: ${err?.message}`)
        }
      }

      if (totalInsights > 0) {
        this.logger.log(`[ads-ai.detect.cron] ${totalInsights} insight(s) novo(s) em ${settings.length} org(s)`)
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[ads-ai.detect.cron] ${err?.message}`)
    }
  }

  /** Run all detection rules for one org. Returns the number of NEW
   * (non-duplicate) insights inserted. */
  async detect(orgId: string): Promise<number> {
    const cfg = await this.settings.getSettings(orgId)
    const campaigns = await this.ctx.loadCampaignsContext(orgId)

    const drafts: DraftInsight[] = []
    for (const c of campaigns) {
      drafts.push(...this.detectAcosAlto(c, cfg.acos_alert_threshold))
      drafts.push(...this.detectRoasBaixo(c, cfg.roas_min_threshold))
      drafts.push(...this.detectBudgetEsgotando(c, cfg.budget_burn_threshold))
      drafts.push(...this.detectCtrQueda(c, cfg.ctr_drop_threshold))
      drafts.push(...this.detectCampanhaZerada(c))
      drafts.push(...this.detectOportunidadeHero(c))
      drafts.push(...await this.detectEstoqueCritico(orgId, c, cfg.stock_critical_days))
      drafts.push(...await this.detectConcorrentePreco(orgId, c))
    }

    return this.persistNew(orgId, drafts)
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  private detectAcosAlto(c: CampaignContext, threshold: number): DraftInsight[] {
    const days = c.metrics_30d.days.slice(-3)
    if (days.length < 3) return []
    const allHigh = days.every(d => d.spend > 0 && d.acos * 100 > threshold)
    if (!allHigh) return []
    const avgAcos = days.reduce((s, d) => s + d.acos, 0) / days.length
    return [{
      type: 'ACOS_ALTO',
      severity: 'high',
      campaign_id: c.id,
      campaign_name: c.name,
      title: `ACoS alto em "${c.name ?? c.id}"`,
      description: `ACoS médio dos últimos 3 dias: ${(avgAcos * 100).toFixed(1)}% (limite: ${threshold}%)`,
      recommendation: 'Revise palavras-chave negativas, ajuste lance ou pause produtos com baixa conversão',
      estimated_impact: `Reduzir gasto em até R$ ${days.reduce((s, d) => s + d.spend, 0).toFixed(2)}/3 dias`,
      data_snapshot: { days, avgAcos, threshold },
    }]
  }

  private detectRoasBaixo(c: CampaignContext, minRoas: number): DraftInsight[] {
    const t = c.metrics_30d.totals
    if (t.spend < 50) return []
    if (t.roas >= minRoas) return []
    return [{
      type: 'ROAS_BAIXO',
      severity: 'high',
      campaign_id: c.id,
      campaign_name: c.name,
      title: `ROAS abaixo do mínimo em "${c.name ?? c.id}"`,
      description: `ROAS atual ${t.roas.toFixed(2)}x está abaixo de ${minRoas}x`,
      recommendation: 'Reduza budget, ajuste lance ou pause se margem não cobre o ACoS',
      estimated_impact: `Gasto desperdiçado nos últimos 30d: R$ ${(t.spend - t.revenue / minRoas).toFixed(2)}`,
      data_snapshot: { roas: t.roas, spend: t.spend, revenue: t.revenue, minRoas },
    }]
  }

  private detectBudgetEsgotando(c: CampaignContext, burnThreshold: number): DraftInsight[] {
    if (!c.daily_budget || c.daily_budget <= 0) return []
    const recent = c.metrics_30d.days.slice(-2)
    if (recent.length < 2) return []
    const burning = recent.every(d => (d.spend / c.daily_budget!) * 100 > burnThreshold)
    if (!burning) return []
    return [{
      type: 'BUDGET_ESGOTANDO_CEDO',
      severity: 'medium',
      campaign_id: c.id,
      campaign_name: c.name,
      title: `Budget esgotando cedo em "${c.name ?? c.id}"`,
      description: `Mais de ${burnThreshold}% do budget gasto nos últimos 2 dias — você pode estar perdendo conversões à tarde`,
      recommendation: `Aumentar budget ou ajustar bid para distribuir gasto ao longo do dia`,
      estimated_impact: `Aumentar budget em 30% pode liberar ~R$ ${(c.daily_budget * 0.3).toFixed(2)}/dia em receita potencial`,
      data_snapshot: { daily_budget: c.daily_budget, recent, burnThreshold },
    }]
  }

  private detectCtrQueda(c: CampaignContext, dropPct: number): DraftInsight[] {
    const days = c.metrics_30d.days
    if (days.length < 14) return []
    const last7 = days.slice(-7)
    const prev7 = days.slice(-14, -7)
    const sum = (arr: typeof days) => arr.reduce((a, d) => ({ c: a.c + d.clicks, i: a.i + d.impressions }), { c: 0, i: 0 })
    const a = sum(last7), b = sum(prev7)
    const ctrA = a.i > 0 ? a.c / a.i : 0
    const ctrB = b.i > 0 ? b.c / b.i : 0
    if (ctrB === 0) return []
    const drop = ((ctrB - ctrA) / ctrB) * 100
    if (drop <= dropPct) return []
    return [{
      type: 'CTR_QUEDA',
      severity: 'medium',
      campaign_id: c.id,
      campaign_name: c.name,
      title: `Queda de CTR em "${c.name ?? c.id}"`,
      description: `CTR caiu ${drop.toFixed(1)}% comparando últimos 7d (${(ctrA * 100).toFixed(2)}%) com 7d anteriores (${(ctrB * 100).toFixed(2)}%)`,
      recommendation: 'Atualize criativos / título / foto principal — pode estar saturado',
      estimated_impact: null,
      data_snapshot: { ctrA, ctrB, dropPct: drop },
    }]
  }

  private detectCampanhaZerada(c: CampaignContext): DraftInsight[] {
    if ((c.status ?? '').toLowerCase() !== 'active') return []
    const recent = c.metrics_30d.days.slice(-2)
    if (recent.length < 2) return []
    if (recent.some(d => d.impressions > 0)) return []
    return [{
      type: 'CAMPANHA_ZERADA',
      severity: 'low',
      campaign_id: c.id,
      campaign_name: c.name,
      title: `Campanha "${c.name ?? c.id}" sem impressões`,
      description: '0 impressões nos últimos 2 dias com campanha ativa',
      recommendation: 'Verifique categoria, aprovação dos itens, lances ou orçamento muito baixo',
      estimated_impact: null,
      data_snapshot: { recent },
    }]
  }

  private detectOportunidadeHero(c: CampaignContext): DraftInsight[] {
    const t = c.metrics_30d.totals
    if (t.roas < 5) return []
    if (!c.daily_budget || c.daily_budget >= 100) return []
    const suggestedBoost = Math.min(c.daily_budget * 2, 300)
    return [{
      type: 'OPORTUNIDADE_HERO',
      severity: 'low',
      campaign_id: c.id,
      campaign_name: c.name,
      title: `🎯 Oportunidade — "${c.name ?? c.id}"`,
      description: `ROAS ${t.roas.toFixed(2)}x com budget de apenas R$ ${c.daily_budget.toFixed(2)}/dia`,
      recommendation: `Considere aumentar budget para R$ ${suggestedBoost.toFixed(2)}/dia`,
      estimated_impact: `Receita potencial adicional ≈ R$ ${((suggestedBoost - c.daily_budget) * t.roas).toFixed(2)}/dia`,
      data_snapshot: { roas: t.roas, current_budget: c.daily_budget, suggested_budget: suggestedBoost },
    }]
  }

  private async detectEstoqueCritico(orgId: string, c: CampaignContext, criticalDays: number): Promise<DraftInsight[]> {
    const t = c.metrics_30d.totals
    const dailySpend = (c.daily_budget ?? 0)
    if (dailySpend < 50 && t.spend / 30 < 50) return []
    const out: DraftInsight[] = []
    for (const item of c.items.slice(0, 3)) { // cap to 3 to avoid n*m blow up
      if (!item.item_id) continue
      // Map item_id (MLB) → product via product_listings
      const { data: vinc } = await supabaseAdmin
        .from('product_listings').select('product_id')
        .eq('listing_id', item.item_id).maybeSingle()
      if (!vinc?.product_id) continue
      const stock = await this.ctx.getProductStock(orgId, vinc.product_id as string)
      if (!stock || stock.days_of_stock == null || stock.days_of_stock > criticalDays) continue
      out.push({
        type: 'ESTOQUE_CRITICO_EM_ADS',
        severity: 'critical',
        campaign_id: c.id,
        campaign_name: c.name,
        title: `Estoque crítico em "${stock.name ?? stock.sku}"`,
        description: `Apenas ${stock.days_of_stock!.toFixed(1)} dias de estoque (${stock.available} un) e a campanha gasta ~R$ ${dailySpend.toFixed(2)}/dia`,
        recommendation: 'Pause a campanha ou reabasteça o estoque urgentemente',
        estimated_impact: `Risco de break: campanha continua gastando sem produto pra entregar`,
        data_snapshot: { stock, dailySpend, item_id: item.item_id },
      })
    }
    return out
  }

  private async detectConcorrentePreco(orgId: string, c: CampaignContext): Promise<DraftInsight[]> {
    const out: DraftInsight[] = []
    for (const item of c.items.slice(0, 3)) {
      if (!item.item_id) continue
      const { data: vinc } = await supabaseAdmin
        .from('product_listings').select('product_id, listing_price')
        .eq('listing_id', item.item_id).maybeSingle()
      if (!vinc?.product_id) continue
      const myPrice = Number(vinc.listing_price ?? 0)
      if (myPrice <= 0) continue
      const competitors = await this.ctx.getCompetitorPrices(orgId, vinc.product_id as string)
      if (!competitors.length) continue
      const cheapest = competitors.reduce((min, x) => {
        const p = Number((x as { current_price?: number }).current_price ?? 0)
        return p > 0 && (min === null || p < min) ? p : min
      }, null as number | null)
      if (!cheapest) continue
      const diffPct = ((myPrice - cheapest) / myPrice) * 100
      if (diffPct < 10) continue
      out.push({
        type: 'CONCORRENTE_PRECO_AGRESSIVO',
        severity: 'medium',
        campaign_id: c.id,
        campaign_name: c.name,
        title: `Concorrente ${diffPct.toFixed(1)}% mais barato em "${c.name ?? c.id}"`,
        description: `Seu preço R$ ${myPrice.toFixed(2)} vs concorrente R$ ${cheapest.toFixed(2)}`,
        recommendation: 'Revise pricing, considere igualar ou reforce diferenciais (frete grátis, garantia)',
        estimated_impact: null,
        data_snapshot: { myPrice, cheapestCompetitor: cheapest, diffPct, item_id: item.item_id },
      })
    }
    return out
  }

  // ── Persistence ────────────────────────────────────────────────────────

  /** Insert only insights that aren't already open with the same
   * (type, campaign_id) so we don't spam duplicates. */
  private async persistNew(orgId: string, drafts: DraftInsight[]): Promise<number> {
    if (drafts.length === 0) return 0
    const { data: existing } = await supabaseAdmin
      .from('ads_ai_insights')
      .select('type, campaign_id')
      .eq('organization_id', orgId)
      .eq('status', 'open')

    const seen = new Set((existing ?? []).map(e => `${e.type}|${e.campaign_id ?? ''}`))
    const fresh = drafts.filter(d => !seen.has(`${d.type}|${d.campaign_id ?? ''}`))
    if (fresh.length === 0) return 0

    const { error } = await supabaseAdmin
      .from('ads_ai_insights')
      .insert(fresh.map(d => ({ ...d, organization_id: orgId })))
    if (error) {
      this.logger.warn(`[ads-ai.detect.persist] ${error.message}`)
      return 0
    }
    return fresh.length
  }
}
