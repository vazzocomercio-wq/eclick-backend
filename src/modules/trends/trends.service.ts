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
