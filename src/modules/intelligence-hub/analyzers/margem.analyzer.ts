import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { BaseAnalyzer } from './base.analyzer'
import type { AnalyzerName, SignalDraft } from './analyzers.types'

const WINDOW_DAYS  = 30
const MIN_SALES    = 5     // não emite signal se vendeu menos que isso na janela
const SIGNAL_TTL_H = 24

const MARGEM_CRITICA_PCT = 5    // < 5%
const MARGEM_BAIXA_PCT   = 15   // 5..15%
const MARGEM_ALTA_PCT    = 50   // > 50% (oportunidade)

interface ProductRow {
  id:   string
  name: string | null
  sku:  string | null
}

interface OrderRow {
  product_id:               string
  contribution_margin_pct:  number | null
  quantity:                 number | null
  sale_price:               number | null
}

/**
 * MargemAnalyzer — calcula margem média 30d por produto a partir de orders.
 * Filtra por MIN_SALES pra evitar signals em produtos com 1-2 vendas.
 *
 * Categorias:
 *   margem_critica   — média < 5%      (critical, score 90)
 *   margem_baixa     — 5% ≤ média < 15% (warning,  score 60)
 *   margem_alta      — média > 50%      (info,     score 35) — oportunidade
 */
@Injectable()
export class MargemAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'margem'

  async scan(orgId: string): Promise<SignalDraft[]> {
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()

    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('product_id, contribution_margin_pct, quantity, sale_price')
      .eq('organization_id', orgId)
      .gte('sold_at', since)
      .not('contribution_margin_pct', 'is', null)
    if (error) {
      this.logger.error(`[margem] org=${orgId} query: ${error.message}`)
      return []
    }

    const rows = (orders ?? []) as OrderRow[]
    if (rows.length === 0) return []

    // Agrega por produto: weighted average por quantidade
    const agg = new Map<string, { weighted_sum: number; weight: number; count: number }>()
    for (const o of rows) {
      if (!o.product_id) continue
      const margin = Number(o.contribution_margin_pct ?? 0)
      const qty    = Number(o.quantity ?? 1) || 1
      const cur    = agg.get(o.product_id) ?? { weighted_sum: 0, weight: 0, count: 0 }
      cur.weighted_sum += margin * qty
      cur.weight       += qty
      cur.count        += 1
      agg.set(o.product_id, cur)
    }

    const productIds = [...agg.keys()]
    if (productIds.length === 0) return []

    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, name, sku')
      .in('id', productIds)
    const productMap = new Map<string, ProductRow>(
      ((products ?? []) as ProductRow[]).map(p => [p.id, p]),
    )

    const drafts: SignalDraft[] = []
    const expiresAt = new Date(Date.now() + SIGNAL_TTL_H * 3_600_000).toISOString()

    for (const [productId, a] of agg) {
      if (a.count < MIN_SALES) continue
      const avgMargin = a.weighted_sum / a.weight  // %
      const product   = productMap.get(productId)
      const draft     = this.classify(productId, product, avgMargin, a.count, expiresAt)
      if (draft) drafts.push(draft)
    }

    this.logger.log(`[margem] org=${orgId} produtos=${productIds.length} signals=${drafts.length}`)
    return drafts
  }

  private classify(
    productId: string, product: ProductRow | undefined,
    margin: number, salesCount: number, expiresAt: string,
  ): SignalDraft | null {
    const name = product?.name ?? `Produto ${productId.slice(0, 8)}`

    if (margin < MARGEM_CRITICA_PCT) {
      return {
        analyzer:    this.name,
        category:    'margem_critica',
        severity:    'critical',
        score:       Math.min(95, 90 + Math.max(0, MARGEM_CRITICA_PCT - margin)),
        entity_type: 'product',
        entity_id:   productId,
        entity_name: name,
        data: { avg_margin_pct: round(margin, 1), sales_count: salesCount, sku: product?.sku, window_days: WINDOW_DAYS },
        summary_pt:  `${name} com margem média de ${round(margin, 1)}% em ${WINDOW_DAYS}d ` +
                     `(${salesCount} venda${salesCount !== 1 ? 's' : ''}).`,
        suggestion_pt: 'Revisar custo, frete e taxas — pode estar vendendo no prejuízo.',
        expires_at:  expiresAt,
      }
    }

    if (margin < MARGEM_BAIXA_PCT) {
      return {
        analyzer:    this.name,
        category:    'margem_baixa',
        severity:    'warning',
        score:       Math.round(50 + (MARGEM_BAIXA_PCT - margin) * 2),
        entity_type: 'product',
        entity_id:   productId,
        entity_name: name,
        data: { avg_margin_pct: round(margin, 1), sales_count: salesCount, sku: product?.sku, window_days: WINDOW_DAYS },
        summary_pt:  `${name} com margem média de ${round(margin, 1)}% em ${WINDOW_DAYS}d.`,
        suggestion_pt: 'Avaliar reajuste de preço ou negociação de custo.',
        expires_at:  expiresAt,
      }
    }

    if (margin > MARGEM_ALTA_PCT) {
      return {
        analyzer:    this.name,
        category:    'margem_alta',
        severity:    'info',
        score:       35,
        entity_type: 'product',
        entity_id:   productId,
        entity_name: name,
        data: { avg_margin_pct: round(margin, 1), sales_count: salesCount, sku: product?.sku, window_days: WINDOW_DAYS },
        summary_pt:  `${name} com margem alta de ${round(margin, 1)}% em ${WINDOW_DAYS}d — oportunidade.`,
        suggestion_pt: 'Considerar acelerar vendas via ads ou ampliar estoque.',
        expires_at:  expiresAt,
      }
    }

    return null
  }
}

function round(n: number, d: number): number {
  const m = Math.pow(10, d)
  return Math.round(n * m) / m
}
