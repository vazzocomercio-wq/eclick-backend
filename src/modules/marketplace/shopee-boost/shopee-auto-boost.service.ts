import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from '../shopee-sync/shopee-product-sync.service'
import { ShopeeListingLinkService } from '../shopee-sync/shopee-listing-link.service'
import { round2 } from '../../../common/margin'
import type { MpConnection } from '../adapters/base'

/** F18 Auto-Boost Inteligente — usa o boost GRATUITO da Shopee (5 slots
 *  simultâneos por loja, 4h cada) escolhendo os produtos certos, 24/7.
 *
 *  Cron a cada 30min (gate env SHOPEE_AUTO_BOOST='on' + opt-in POR LOJA em
 *  shopee.boost_config): pra cada loja habilitada, consulta get_boosted_list
 *  (respeita a janela — slot ocupado espera o cool_down expirar), calcula os
 *  slots livres e preenche com os melhores candidatos do ranking composto:
 *
 *    Algorithm Score × margem de contribuição × giro 30d × estoque
 *
 *  Filtros duros: anúncio vinculado a produto, estoque > 0, margem conhecida
 *  não-negativa, fora da lista de exclusão, e ROTAÇÃO (não repete item antes
 *  de rotation_hours — todos merecem vitrine). Cada boost é logado em
 *  shopee.boost_log com o racional completo. */
@Injectable()
export class ShopeeAutoBoostService {
  private readonly logger = new Logger(ShopeeAutoBoostService.name)
  /** Teto real da Shopee, validado live (6º item → bump slot limit). */
  private static readonly SHOPEE_SLOTS = 5

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly linkService: ShopeeListingLinkService,
  ) {}

  // ── cron ──────────────────────────────────────────────────────────────────

  /** A cada 30min (boost dura 4h; slots vencem em horários diferentes — o
   *  ciclo curto reaproveita slot livre sem esperar a janela cheia). */
  @Cron('7,37 * * * *', { name: 'shopee-auto-boost' })
  async boostTick(): Promise<void> {
    if (process.env.SHOPEE_AUTO_BOOST !== 'on') return
    const { data: cfgs } = await supabaseAdmin
      .schema('shopee').from('boost_config')
      .select('organization_id, shop_id')
      .eq('enabled', true)
    for (const cfg of cfgs ?? []) {
      try {
        await this.runCycle(cfg.organization_id as string, Number(cfg.shop_id), { source: 'auto' })
      } catch (e) {
        this.logger.warn(`[shopee.boost.cron] org=${cfg.organization_id} shop=${cfg.shop_id}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  // ── config ────────────────────────────────────────────────────────────────

  async getConfigs(orgId: string): Promise<Map<number, BoostConfig>> {
    const { data } = await supabaseAdmin
      .schema('shopee').from('boost_config')
      .select('*')
      .eq('organization_id', orgId)
    const map = new Map<number, BoostConfig>()
    for (const row of (data ?? []) as BoostConfigRow[]) {
      map.set(Number(row.shop_id), this.hydrateConfig(row))
    }
    return map
  }

  private hydrateConfig(row: BoostConfigRow | null): BoostConfig {
    return {
      enabled:           Boolean(row?.enabled ?? false),
      strategy:          (row?.strategy as BoostStrategy) ?? 'balanced',
      excluded_item_ids: Array.isArray(row?.excluded_item_ids) ? row!.excluded_item_ids.map(Number) : [],
      max_per_cycle:     Math.min(Math.max(Number(row?.max_per_cycle ?? ShopeeAutoBoostService.SHOPEE_SLOTS), 1), ShopeeAutoBoostService.SHOPEE_SLOTS),
      rotation_hours:    Math.max(Number(row?.rotation_hours ?? 48), 4),
    }
  }

  async upsertConfig(orgId: string, shopId: number, patch: Partial<BoostConfig>): Promise<BoostConfig> {
    if (!Number.isFinite(shopId)) throw new BadRequestException('shop_id inválido')
    if (patch.strategy && !['balanced', 'margin', 'visibility', 'giro'].includes(patch.strategy)) {
      throw new BadRequestException('strategy deve ser balanced | margin | visibility | giro')
    }
    const row: Record<string, unknown> = {
      organization_id: orgId,
      shop_id:         shopId,
      updated_at:      new Date().toISOString(),
    }
    if (patch.enabled           !== undefined) row.enabled           = Boolean(patch.enabled)
    if (patch.strategy          !== undefined) row.strategy          = patch.strategy
    if (patch.excluded_item_ids !== undefined) row.excluded_item_ids = (patch.excluded_item_ids ?? []).map(Number).filter(Number.isFinite)
    if (patch.max_per_cycle     !== undefined) row.max_per_cycle     = Math.min(Math.max(Number(patch.max_per_cycle) || ShopeeAutoBoostService.SHOPEE_SLOTS, 1), ShopeeAutoBoostService.SHOPEE_SLOTS)
    if (patch.rotation_hours    !== undefined) row.rotation_hours    = Math.max(Number(patch.rotation_hours) || 48, 4)
    const { data, error } = await supabaseAdmin
      .schema('shopee').from('boost_config')
      .upsert(row, { onConflict: 'organization_id,shop_id' })
      .select().single()
    if (error) throw new Error(`boost_config upsert: ${error.message}`)
    return this.hydrateConfig(data as BoostConfigRow)
  }

  // ── seleção inteligente ──────────────────────────────────────────────────

  /** Candidatos ranqueados da loja (já filtrados e com racional). */
  async getCandidates(orgId: string, shopId: number, cfg: BoostConfig, opts: { limit?: number } = {}): Promise<BoostCandidate[]> {
    const status = await this.linkService.getLinkStatus(orgId)
    const excluded = new Set(cfg.excluded_item_ids)

    // rotação: último boost por item dentro da janela
    const since = new Date(Date.now() - cfg.rotation_hours * 3600_000).toISOString()
    const { data: recent } = await supabaseAdmin
      .schema('shopee').from('boost_log')
      .select('item_id, boosted_at')
      .eq('organization_id', orgId)
      .eq('shop_id', shopId)
      .gte('boosted_at', since)
    const lastBoost = new Map<number, string>()
    for (const r of (recent ?? []) as Array<{ item_id: number; boosted_at: string }>) {
      const id = Number(r.item_id)
      if (!lastBoost.has(id)) lastBoost.set(id, r.boosted_at)
    }

    // giro 30d por produto (vendas Shopee não-canceladas)
    const sales = await this.salesByProduct(orgId, shopId)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = (status.items as any[]).filter(i =>
      Number(i.shop_id) === Number(shopId) &&
      i.linked && i.product &&
      Number(i.product.stock ?? 0) > 0 &&
      !excluded.has(Number(i.item_id)) &&
      // margem conhecida negativa = vende no prejuízo → não merece vitrine
      (i.margin == null || Number(i.margin.contribution_margin_pct) > 0),
    )

    const w = STRATEGY_WEIGHTS[cfg.strategy] ?? STRATEGY_WEIGHTS.balanced
    const out: BoostCandidate[] = []
    for (const i of pool) {
      const itemId    = Number(i.item_id)
      const rotBlock  = lastBoost.get(itemId) ?? null
      const algo      = Number(i.algo_score ?? 0)
      const marginPct = i.margin != null ? Number(i.margin.contribution_margin_pct) : null
      const stock     = Number(i.product.stock ?? 0)
      const sold30    = sales.get(i.product.id as string) ?? 0

      const scoreNorm  = Math.min(Math.max(algo, 0), 100) / 100
      // margem desconhecida = neutro 0.4 (não pune nem premia)
      const marginNorm = marginPct != null ? Math.min(Math.max(marginPct, 0), 50) / 50 : 0.4
      const salesNorm  = Math.min(sold30, 30) / 30
      const stockNorm  = Math.min(stock, 50) / 50
      const composite  = round2(
        w.score * scoreNorm + w.margin * marginNorm + w.sales * salesNorm + w.stock * stockNorm,
      )

      const motivo =
        `Score ${algo}` +
        (marginPct != null ? `, margem ${marginPct.toFixed(1)}%` : ', margem n/d') +
        `, ${sold30} venda(s) 30d, estoque ${stock} → composto ${composite.toFixed(2)} (${cfg.strategy})`

      out.push({
        item_id:     itemId,
        product_id:  i.product.id as string,
        title:       (i.title ?? i.product.name ?? null) as string | null,
        algo_score:  algo,
        margin_pct:  marginPct,
        stock,
        sales_30d:   sold30,
        composite,
        motivo,
        blocked_by_rotation: rotBlock != null,
        last_boosted_at:     rotBlock,
      })
    }
    out.sort((a, b) => b.composite - a.composite)
    const limit = opts.limit ?? 50
    return out.slice(0, limit)
  }

  /** Unidades vendidas (30d) por product_id no canal Shopee da loja. */
  private async salesByProduct(orgId: string, shopId: number): Promise<Map<string, number>> {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString()
    const { data } = await supabaseAdmin
      .from('orders')
      .select('product_id, quantity, status')
      .eq('organization_id', orgId)
      .eq('source', 'shopee')
      .eq('channel_account_id', String(shopId))
      .gte('sold_at', since)
      .not('product_id', 'is', null)
      .limit(5000)
    const map = new Map<string, number>()
    for (const r of (data ?? []) as Array<{ product_id: string; quantity: number; status: string | null }>) {
      const st = (r.status ?? '').toUpperCase()
      if (st === 'CANCELLED' || st === 'IN_CANCEL') continue
      map.set(r.product_id, (map.get(r.product_id) ?? 0) + (Number(r.quantity) || 0))
    }
    return map
  }

  // ── ciclo (cron + manual) ────────────────────────────────────────────────

  /** Roda 1 ciclo pra loja: slots livres → boost dos melhores candidatos.
   *  dryRun devolve o plano SEM aplicar (preview da tela / gate do 1º ciclo). */
  async runCycle(orgId: string, shopId: number, opts: { source?: 'auto' | 'manual'; dryRun?: boolean } = {}): Promise<CycleResult> {
    const source = opts.source ?? 'manual'
    const resolved = await this.mp.resolveByShop(orgId, shopId, 'shopee')
    if (!resolved) throw new NotFoundException(`Loja Shopee ${shopId} não conectada nesta organização`)
    const conn = await this.productSync.ensureFreshToken(resolved.conn as MpConnection)

    const cfgs = await this.getConfigs(orgId)
    const cfg  = cfgs.get(shopId) ?? this.hydrateConfig(null)

    const active = await this.adapter.getBoostedList(conn)
    const freeSlots = Math.max(0, Math.min(
      ShopeeAutoBoostService.SHOPEE_SLOTS - active.length,
      cfg.max_per_cycle,
    ))
    if (freeSlots === 0) {
      return { shop_id: shopId, active_count: active.length, free_slots: 0, boosted: [], skipped_reason: 'Todos os slots ocupados — aguardando a janela de 4h da Shopee.' }
    }

    const candidates = await this.getCandidates(orgId, shopId, cfg)
    const eligible = candidates.filter(c => !c.blocked_by_rotation)
    const picks = eligible.slice(0, freeSlots)
    if (!picks.length) {
      return { shop_id: shopId, active_count: active.length, free_slots: freeSlots, boosted: [], skipped_reason: 'Nenhum candidato elegível (estoque/margem/rotação/exclusões).' }
    }

    if (opts.dryRun) {
      return { shop_id: shopId, active_count: active.length, free_slots: freeSlots, boosted: picks, dry_run: true }
    }

    const res = await this.adapter.boostItems(conn, picks.map(p => p.item_id))
    const okSet = new Set(res.success)
    const boosted = picks.filter(p => okSet.has(p.item_id))
    const failed = picks
      .filter(p => !okSet.has(p.item_id))
      .map(p => ({ ...p, fail_reason: res.failures.find(f => f.item_id === p.item_id)?.reason ?? 'não confirmado pela Shopee' }))

    if (boosted.length) {
      const nowIso = new Date().toISOString()
      const { error } = await supabaseAdmin.schema('shopee').from('boost_log').insert(
        boosted.map(b => ({
          organization_id: orgId,
          shop_id:         shopId,
          item_id:         b.item_id,
          product_id:      b.product_id,
          title:           b.title,
          boosted_at:      nowIso,
          algo_score:      b.algo_score,
          margin_pct:      b.margin_pct,
          stock:           b.stock,
          sales_30d:       b.sales_30d,
          composite:       b.composite,
          motivo:          b.motivo,
          source,
        })),
      )
      if (error) this.logger.warn(`[shopee.boost] log insert: ${error.message}`)
    }

    this.logger.log(`[shopee.boost] org=${orgId} shop=${shopId} src=${source} boosted=${boosted.map(b => b.item_id).join(',') || '-'} fail=${failed.length}`)
    return { shop_id: shopId, active_count: active.length + boosted.length, free_slots: freeSlots, boosted, failed: failed.length ? failed : undefined }
  }

  // ── overview pra tela ─────────────────────────────────────────────────────

  /** Visão completa por loja: config + boosts ativos AGORA + próximos
   *  candidatos (com racional) + histórico recente. */
  async overview(orgId: string): Promise<{
    gate_on: boolean
    shops: ShopOverview[]
  }> {
    const conns = (await this.mp.listConnections(orgId)).filter(c => c.platform === 'shopee')
    if (!conns.length) throw new NotFoundException('Nenhuma loja Shopee conectada nesta organização')
    const cfgs = await this.getConfigs(orgId)

    const shops: ShopOverview[] = []
    for (const baseConn of conns) {
      if (!baseConn.shop_id) continue
      const shopId = baseConn.shop_id
      const cfg = cfgs.get(shopId) ?? this.hydrateConfig(null)
      let active: Array<{ item_id: number; cool_down_second: number }> = []
      let apiError: string | null = null
      try {
        const conn = await this.productSync.ensureFreshToken(baseConn)
        active = await this.adapter.getBoostedList(conn)
      } catch (e) {
        apiError = e instanceof Error ? e.message : String(e)
      }
      let candidates: BoostCandidate[] = []
      try {
        candidates = await this.getCandidates(orgId, shopId, cfg, { limit: 12 })
      } catch (e) {
        apiError = apiError ?? (e instanceof Error ? e.message : String(e))
      }
      const { data: history } = await supabaseAdmin
        .schema('shopee').from('boost_log')
        .select('item_id, title, boosted_at, algo_score, margin_pct, stock, sales_30d, composite, motivo, source')
        .eq('organization_id', orgId)
        .eq('shop_id', shopId)
        .order('boosted_at', { ascending: false })
        .limit(40)

      shops.push({
        shop_id:    shopId,
        nickname:   baseConn.nickname ?? `Shopee #${shopId}`,
        config:     cfg,
        active,
        candidates,
        history:    (history ?? []) as ShopOverview['history'],
        api_error:  apiError,
      })
    }
    return { gate_on: process.env.SHOPEE_AUTO_BOOST === 'on', shops }
  }
}

// ── tipos ────────────────────────────────────────────────────────────────────

export type BoostStrategy = 'balanced' | 'margin' | 'visibility' | 'giro'

export interface BoostConfig {
  enabled:           boolean
  strategy:          BoostStrategy
  excluded_item_ids: number[]
  max_per_cycle:     number
  rotation_hours:    number
}

interface BoostConfigRow {
  enabled?: boolean; strategy?: string; excluded_item_ids?: unknown[]
  max_per_cycle?: number; rotation_hours?: number; shop_id?: number | string
}

export interface BoostCandidate {
  item_id:             number
  product_id:          string
  title:               string | null
  algo_score:          number
  margin_pct:          number | null
  stock:               number
  sales_30d:           number
  composite:           number
  motivo:              string
  blocked_by_rotation: boolean
  last_boosted_at:     string | null
  fail_reason?:        string
}

export interface CycleResult {
  shop_id:         number
  active_count:    number
  free_slots:      number
  boosted:         BoostCandidate[]
  failed?:         BoostCandidate[]
  dry_run?:        boolean
  skipped_reason?: string
}

export interface ShopOverview {
  shop_id:    number
  nickname:   string
  config:     BoostConfig
  active:     Array<{ item_id: number; cool_down_second: number }>
  candidates: BoostCandidate[]
  history:    Array<{
    item_id: number; title: string | null; boosted_at: string
    algo_score: number | null; margin_pct: number | null; stock: number | null
    sales_30d: number | null; composite: number | null; motivo: string | null; source: string
  }>
  api_error:  string | null
}

/** Pesos do ranking composto por estratégia (somam 1). */
const STRATEGY_WEIGHTS: Record<BoostStrategy, { score: number; margin: number; sales: number; stock: number }> = {
  balanced:   { score: 0.35, margin: 0.30, sales: 0.25, stock: 0.10 },
  margin:     { score: 0.25, margin: 0.50, sales: 0.15, stock: 0.10 },
  visibility: { score: 0.50, margin: 0.20, sales: 0.20, stock: 0.10 },
  giro:       { score: 0.20, margin: 0.20, sales: 0.50, stock: 0.10 },
}
