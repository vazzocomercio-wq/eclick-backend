import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Sinais COMERCIAIS por produto pro Autopilot de Campanha (Social Commerce AI
 * Fase 2). Lê catálogo + estoque + Radar do SaaS e devolve um resumo que o
 * Active usa pra (a) temperar o roteiro/legenda e (b) rankear produtos na
 * geração em lote ("a IA escolhe O QUE empurrar").
 *
 * margin_pct é uma APROXIMAÇÃO (Preço − Custo − Imposto) / Preço — ignora
 * tarifa/frete do marketplace (que dependem do anúncio). Serve pra RANKEAR
 * (alta vs baixa margem), não como número fiscal exato.
 */

export type DemandTrend = 'rising' | 'stable' | 'unknown'

export interface CommercialSignal {
  product_id: string
  margin_pct: number | null
  stock: number
  is_overstock: boolean
  days_since_movement: number | null
  demand_trend: DemandTrend
}

export interface CampaignCandidate extends CommercialSignal {
  product_name: string
  product_photo_url: string | null
  product_photos: string[]
  product_description: string | null
  category: string | null
  score: number
}

export type CandidateStrategy = 'high_margin' | 'overstock' | 'radar' | 'mixed'

const OVERSTOCK_DAYS = 30

function toHttps(u?: string | null): string {
  const s = (u ?? '').trim()
  if (s.startsWith('http://')) return 'https://' + s.slice(7)
  if (s.startsWith('//')) return 'https:' + s
  return s
}

interface ProductRow {
  id: string
  name?: string | null
  ml_title?: string | null
  photo_urls?: string[] | null
  description?: string | null
  category?: string | null
  price?: number | string | null
  cost_price?: number | string | null
  tax_percentage?: number | string | null
  tax_on_freight?: boolean | null
  stock?: number | null
}

@Injectable()
export class InternalProductsSignalsService {
  private readonly log = new Logger(InternalProductsSignalsService.name)

  /** Sinais pra um conjunto específico de produtos. */
  async signals(orgId: string, productIds: string[]): Promise<CommercialSignal[]> {
    const ids = [...new Set(productIds.filter(Boolean))]
    if (!ids.length) return []
    const { data: prods } = await supabaseAdmin
      .from('products')
      .select('id, price, cost_price, tax_percentage, tax_on_freight, stock')
      .eq('organization_id', orgId)
      .in('id', ids)
    const taxCfg = await this.orgTax(orgId)
    const lastMove = await this.lastMovements(ids)
    const demand = await this.demandTrends(orgId, ids)
    return (prods ?? []).map((p) =>
      this.toSignal(p as ProductRow, taxCfg, lastMove, demand),
    )
  }

  /** Produtos rankeados por estratégia comercial (pra geração em lote). */
  async candidates(
    orgId: string,
    strategy: CandidateStrategy,
    limit: number,
  ): Promise<CampaignCandidate[]> {
    const { data: prods } = await supabaseAdmin
      .from('products')
      .select(
        'id, name, ml_title, photo_urls, description, category, price, cost_price, tax_percentage, tax_on_freight, stock',
      )
      .eq('organization_id', orgId)
      .not('photo_urls', 'is', null)
      .gt('price', 0)
      .order('updated_at', { ascending: false })
      .limit(400)
    const rows = (prods ?? []) as ProductRow[]
    const ids = rows.map((p) => p.id)
    const taxCfg = await this.orgTax(orgId)
    const lastMove = await this.lastMovements(ids)
    const demand = await this.demandTrends(orgId, ids)

    const cands: CampaignCandidate[] = rows
      .map((p) => {
        const sig = this.toSignal(p, taxCfg, lastMove, demand)
        const photos = (p.photo_urls ?? [])
          .filter(Boolean)
          .map(toHttps)
          .filter((u) => u.startsWith('http'))
        return {
          ...sig,
          product_name: (p.ml_title || p.name || 'Produto').trim(),
          product_photo_url: photos[0] ?? null,
          product_photos: photos,
          product_description: p.description ?? null,
          category: p.category ?? null,
          score: 0,
        }
      })
      .filter((c) => !!c.product_photo_url)

    for (const c of cands) c.score = this.score(c, strategy)
    cands.sort((a, b) => b.score - a.score)
    return cands.slice(0, Math.max(1, Math.min(limit, 20)))
  }

  // ─── internals ────────────────────────────────────

  private score(c: CampaignCandidate, strategy: CandidateStrategy): number {
    const margin = c.margin_pct ?? 0
    const overstock = c.is_overstock ? 1 : 0
    const demand = c.demand_trend === 'rising' ? 1 : 0
    const stale = c.days_since_movement ?? 0
    if (strategy === 'high_margin') return margin
    if (strategy === 'overstock') return overstock * 1000 + stale
    if (strategy === 'radar') return demand * 1000 + margin
    // mixed: combina os três
    return margin + overstock * 30 + demand * 40
  }

  private toSignal(
    p: ProductRow,
    taxCfg: { pct: number },
    lastMove: Record<string, string>,
    demand: Record<string, DemandTrend>,
  ): CommercialSignal {
    const price = Number(p.price) || 0
    const cost = Number(p.cost_price) || 0
    const taxPct = p.tax_percentage != null ? Number(p.tax_percentage) : taxCfg.pct
    const taxAmount = price * (taxPct / 100)
    const margin_pct =
      price > 0 && cost > 0
        ? +(((price - cost - taxAmount) / price) * 100).toFixed(1)
        : null
    const stock = Number(p.stock) || 0
    const lm = lastMove[p.id]
    const days = lm
      ? Math.floor((Date.now() - new Date(lm).getTime()) / 86_400_000)
      : null
    const is_overstock = stock > 0 && days !== null && days > OVERSTOCK_DAYS
    return {
      product_id: p.id,
      margin_pct,
      stock,
      is_overstock,
      days_since_movement: days,
      demand_trend: demand[p.id] ?? 'unknown',
    }
  }

  private async orgTax(orgId: string): Promise<{ pct: number }> {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select('default_tax_percentage')
      .eq('id', orgId)
      .maybeSingle()
    return { pct: Number((data as { default_tax_percentage?: number })?.default_tax_percentage ?? 0) }
  }

  /** MAX(last_movement_at) por produto (entre rows consolidada/plataforma). */
  private async lastMovements(ids: string[]): Promise<Record<string, string>> {
    if (!ids.length) return {}
    const { data } = await supabaseAdmin
      .from('product_stock')
      .select('product_id, last_movement_at')
      .in('product_id', ids)
      .not('last_movement_at', 'is', null)
    const out: Record<string, string> = {}
    for (const r of (data ?? []) as { product_id: string; last_movement_at: string }[]) {
      const prev = out[r.product_id]
      if (!prev || new Date(r.last_movement_at) > new Date(prev)) {
        out[r.product_id] = r.last_movement_at
      }
    }
    return out
  }

  /** Demanda via Radar (best-effort — orgs sem Radar voltam 'unknown'). */
  private async demandTrends(
    orgId: string,
    ids: string[],
  ): Promise<Record<string, DemandTrend>> {
    if (!ids.length) return {}
    try {
      const { data: watch } = await supabaseAdmin
        .from('radar_catalog_products')
        .select('id, product_id')
        .eq('organization_id', orgId)
        .in('product_id', ids)
      const rows = (watch ?? []) as { id: string; product_id: string }[]
      if (!rows.length) return {}
      const radarIds = rows.map((r) => r.id)
      const { data: ev } = await supabaseAdmin
        .from('radar_events')
        .select('catalog_product_ref, status')
        .in('catalog_product_ref', radarIds)
        .eq('status', 'novo')
      const hot = new Set(
        ((ev ?? []) as { catalog_product_ref: string }[]).map(
          (e) => e.catalog_product_ref,
        ),
      )
      const out: Record<string, DemandTrend> = {}
      for (const r of rows) {
        out[r.product_id] = hot.has(r.id) ? 'rising' : 'stable'
      }
      return out
    } catch (e) {
      this.log.warn(`demandTrends best-effort falhou: ${(e as Error).message}`)
      return {}
    }
  }
}
