import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { TrendsCollectorService } from './trends-collector.service'
import { TrendsScoreService } from './trends-score.service'
import { BuyDecision, CollectResult, RadarCard, TrendsSettings } from './trends.types'

/** F-Trends Fase 1 — orquestração + leitura.
 *  collectAndScore(): coleta sinais do ML + recomputa scores (manual ou cron). */
@Injectable()
export class TrendsService {
  private readonly logger = new Logger(TrendsService.name)

  constructor(
    private readonly collector: TrendsCollectorService,
    private readonly scorer:    TrendsScoreService,
  ) {}

  // ── pipeline ─────────────────────────────────────────────────────────────

  async collectAndScore(orgId: string): Promise<CollectResult & { scored: number }> {
    const settings = await this.getSettings(orgId)
    const collect = await this.collector.collect(orgId, settings.categories.length ? settings.categories : undefined)
    const { scored } = await this.scorer.scoreOrg(orgId)
    return { ...collect, scored }
  }

  /** Árvore de categorias do ML pro seletor (raízes ou filhos de `parent`). */
  listCategories(orgId: string, parentId?: string | null) {
    return this.collector.listCategories(orgId, parentId)
  }

  /** Análise profunda de UM produto: visitas (até 90d reais do ML), histórico de
   *  preço/ranking/score (dos snapshots), KPIs. Vendas/conversão de concorrente
   *  NÃO existem (ML bloqueia item de terceiro). */
  async productAnalytics(orgId: string, productId: string, days: number): Promise<Record<string, unknown>> {
    const { data: prod } = await supabaseAdmin
      .from('trends_products').select('*').eq('organization_id', orgId).eq('id', productId).maybeSingle()
    if (!prod) throw new BadRequestException('Produto não encontrado')
    const product = prod as { id: string; external_id: string; name: string; category_name: string | null; url: string | null; thumbnail: string | null; price_ref_cents: number | null }

    const { data: sc } = await supabaseAdmin
      .from('trends_scores').select('*').eq('organization_id', orgId).eq('product_id', productId).maybeSingle()

    const since = new Date(Date.now() - days * 86400_000).toISOString()
    const { data: sigs } = await supabaseAdmin
      .from('trends_signals')
      .select('signal_type, position, metric_value, captured_at')
      .eq('organization_id', orgId)
      .eq('external_id', product.external_id)
      .in('signal_type', ['best_seller', 'price', 'score'])
      .gte('captured_at', since)
      .order('captured_at', { ascending: true })
    const rows = (sigs ?? []) as { signal_type: string; position: number | null; metric_value: number | null; captured_at: string }[]

    const rankSeries  = rows.filter(r => r.signal_type === 'best_seller' && r.position != null).map(r => ({ date: r.captured_at, value: r.position as number }))
    const priceSeries = rows.filter(r => r.signal_type === 'price' && r.metric_value != null).map(r => ({ date: r.captured_at, value: r.metric_value as number }))
    const scoreSeries = rows.filter(r => r.signal_type === 'score' && r.metric_value != null).map(r => ({ date: r.captured_at, value: r.metric_value as number }))

    const live = await this.collector.getLiveAnalytics(orgId, product.external_id, days)

    const priceVals = priceSeries.map(p => p.value)
    const stats = (arr: number[]) => arr.length
      ? { min: Math.min(...arr), max: Math.max(...arr), avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) }
      : { min: null, max: null, avg: null }

    return {
      product:      { ...product, current_price_cents: live.currentPriceCents ?? product.price_ref_cents },
      score:        sc ?? null,
      visits: {
        available: live.available,
        series:    live.visits,
        total:     live.visitsTotal,
        avgPerDay: live.visits.length ? Math.round(live.visitsTotal / live.visits.length) : 0,
        peak:      live.visits.length ? live.visits.reduce((a, b) => (a.total >= b.total ? a : b)) : null,
      },
      price:        { series: priceSeries, ...stats(priceVals), points: priceSeries.length },
      rank:         { series: rankSeries, best: rankSeries.length ? Math.min(...rankSeries.map(r => r.value)) : null, points: rankSeries.length },
      scoreHistory: { series: scoreSeries, points: scoreSeries.length },
      salesAvailable: false,
      days,
    }
  }

  // ── leitura do radar ──────────────────────────────────────────────────────

  async radar(args: {
    orgId: string
    decision?: BuyDecision | null
    category?: string | null
    minScore?: number | null
    limit: number
    offset: number
  }): Promise<{ items: RadarCard[]; total: number }> {
    let q = supabaseAdmin
      .from('v_trends_radar')
      .select('*', { count: 'exact' })
      .eq('organization_id', args.orgId)
      .eq('kind', 'catalog_product')
      .order('trend_score', { ascending: false, nullsFirst: false })
      .range(args.offset, args.offset + args.limit - 1)

    if (args.decision)         q = q.eq('buy_decision', args.decision)
    if (args.category)         q = q.eq('category_id', args.category)
    if (args.minScore != null) q = q.gte('trend_score', args.minScore)

    const { data, count, error } = await q
    if (error) throw new BadRequestException(`Falha ao ler radar: ${error.message}`)
    return { items: (data ?? []) as RadarCard[], total: count ?? 0 }
  }

  /** Keywords em alta (demanda de busca) — captura mais recente por categoria. */
  async risingSearches(orgId: string, category?: string | null, limit = 40): Promise<
    { term: string; position: number; category_id: string | null; category_name: string | null }[]
  > {
    let q = supabaseAdmin
      .from('trends_signals')
      .select('term, position, category_id, category_name, captured_at')
      .eq('organization_id', orgId)
      .eq('signal_type', 'search_trend')
      .not('term', 'is', null)
      .order('captured_at', { ascending: false })
      .limit(400)
    if (category) q = q.eq('category_id', category)

    const { data } = await q
    const seen = new Set<string>()
    const out: { term: string; position: number; category_id: string | null; category_name: string | null }[] = []
    for (const r of (data ?? []) as { term: string; position: number; category_id: string | null; category_name: string | null }[]) {
      const key = `${r.category_id ?? 'g'}::${r.term}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ term: r.term, position: r.position, category_id: r.category_id, category_name: r.category_name })
      if (out.length >= limit) break
    }
    return out.sort((a, b) => a.position - b.position)
  }

  // ── watchlist ───────────────────────────────────────────────────────────

  async setWatch(orgId: string, productId: string, decision: string, note: string | null, userId: string | null) {
    const allowed = ['comprando', 'observando', 'descartado']
    if (!allowed.includes(decision)) throw new BadRequestException('decision inválida')
    const { error } = await supabaseAdmin.from('trends_watchlist').upsert({
      organization_id: orgId, product_id: productId, decision, note, created_by: userId,
    }, { onConflict: 'organization_id,product_id' })
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  async removeWatch(orgId: string, productId: string) {
    const { error } = await supabaseAdmin.from('trends_watchlist')
      .delete().eq('organization_id', orgId).eq('product_id', productId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  // ── settings ──────────────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<TrendsSettings> {
    const { data } = await supabaseAdmin
      .from('trends_settings').select('*').eq('organization_id', orgId).maybeSingle()
    if (data) return data as TrendsSettings
    // default (não persiste até o usuário salvar)
    return {
      organization_id: orgId, platform: 'mercado_livre', categories: [],
      target_margin_pct: 15, auto_enabled: false, updated_at: new Date().toISOString(),
    }
  }

  async saveSettings(orgId: string, patch: Partial<Pick<TrendsSettings, 'categories' | 'target_margin_pct' | 'auto_enabled'>>) {
    const { error } = await supabaseAdmin.from('trends_settings').upsert({
      organization_id: orgId,
      ...(patch.categories        != null ? { categories: patch.categories } : {}),
      ...(patch.target_margin_pct != null ? { target_margin_pct: patch.target_margin_pct } : {}),
      ...(patch.auto_enabled      != null ? { auto_enabled: patch.auto_enabled } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'organization_id' })
    if (error) throw new BadRequestException(error.message)
    return this.getSettings(orgId)
  }

  /** Orgs com cron diário ligado (pro worker). */
  async autoEnabledOrgs(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('trends_settings').select('organization_id').eq('auto_enabled', true)
    return ((data ?? []) as { organization_id: string }[]).map(r => r.organization_id)
  }
}
