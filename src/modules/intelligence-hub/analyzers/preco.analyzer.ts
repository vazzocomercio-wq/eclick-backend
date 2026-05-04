import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { BaseAnalyzer } from './base.analyzer'
import type { AnalyzerName, SignalDraft } from './analyzers.types'

const SIGNAL_TTL_HOURS = 12

interface CompetitorRow {
  id:            string
  product_id:    string | null
  title:         string | null
  seller:        string | null
  current_price: number | null
  my_price:      number | null
  status:        string
  last_checked:  string | null
}

interface ProductRow {
  id:   string
  name: string | null
  sku:  string | null
}

/**
 * PrecoAnalyzer — compara my_price × current_price dos concorrentes ativos.
 *
 * Categorias:
 *   preco_acima_15        — my_price > competitor + 15%   (critical, score 85+)
 *   preco_acima_5         — my_price > competitor +  5%   (warning,  score 55-75)
 *   preco_competitivo     — my_price ≤ competitor         (info,     score 30) — somente se diff < -10%
 *
 * Pega o concorrente com o MENOR current_price por produto pra evitar
 * múltiplos signals do mesmo produto.
 */
@Injectable()
export class PrecoAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'preco'

  async scan(orgId: string): Promise<SignalDraft[]> {
    const { data, error } = await supabaseAdmin
      .from('competitors')
      .select('id, product_id, title, seller, current_price, my_price, status, last_checked')
      .eq('organization_id', orgId)
      .eq('status', 'active')
    if (error) {
      this.logger.error(`[preco] org=${orgId} query: ${error.message}`)
      return []
    }

    const rows = (data ?? []) as CompetitorRow[]
    if (rows.length === 0) return []

    // Para cada product, pega o concorrente mais barato com my_price > 0
    const cheapestByProduct = new Map<string, CompetitorRow>()
    for (const r of rows) {
      if (!r.product_id || !r.current_price || !r.my_price) continue
      if (r.my_price <= 0 || r.current_price <= 0) continue
      const cur = cheapestByProduct.get(r.product_id)
      if (!cur || (r.current_price < (cur.current_price ?? Infinity))) {
        cheapestByProduct.set(r.product_id, r)
      }
    }

    if (cheapestByProduct.size === 0) return []

    // Buscar product names em batch
    const productIds = [...cheapestByProduct.keys()]
    const { data: products } = await supabaseAdmin
      .from('products')
      .select('id, name, sku')
      .in('id', productIds)
    const productMap = new Map<string, ProductRow>(
      ((products ?? []) as ProductRow[]).map(p => [p.id, p]),
    )

    const drafts: SignalDraft[] = []
    const expiresAt = new Date(Date.now() + SIGNAL_TTL_HOURS * 3_600_000).toISOString()

    for (const [productId, comp] of cheapestByProduct) {
      const product = productMap.get(productId)
      const myPrice  = comp.my_price!
      const compPrice = comp.current_price!
      const diffPct = ((myPrice - compPrice) / compPrice) * 100  // positivo = mais caro

      const draft = this.classify(productId, product, comp, myPrice, compPrice, diffPct, expiresAt)
      if (draft) drafts.push(draft)
    }

    this.logger.log(`[preco] org=${orgId} produtos=${cheapestByProduct.size} signals=${drafts.length}`)
    return drafts
  }

  private classify(
    productId: string,
    product:   ProductRow | undefined,
    comp:      CompetitorRow,
    my:        number,
    competitor: number,
    diffPct:   number,
    expiresAt: string,
  ): SignalDraft | null {
    const name = product?.name ?? `Produto ${productId.slice(0, 8)}`
    const seller = comp.seller ?? 'Concorrente'

    if (diffPct >= 15) {
      return {
        analyzer:    this.name,
        category:    'preco_acima',
        severity:    'critical',
        score:       Math.min(95, 80 + diffPct / 2),
        entity_type: 'product',
        entity_id:   productId,
        entity_name: name,
        data: { my_price: my, competitor_price: competitor, diff_pct: round(diffPct, 1), seller, sku: product?.sku },
        summary_pt:  `${name} está ${round(diffPct, 1)}% mais caro que ${seller} ` +
                     `(R$ ${my.toFixed(2)} vs R$ ${competitor.toFixed(2)}).`,
        suggestion_pt: `Ajustar preço pra próximo de R$ ${competitor.toFixed(2)} ou destacar diferenciais.`,
        expires_at:  expiresAt,
      }
    }

    if (diffPct >= 5) {
      return {
        analyzer:    this.name,
        category:    'preco_acima',
        severity:    'warning',
        score:       Math.round(50 + diffPct * 2),
        entity_type: 'product',
        entity_id:   productId,
        entity_name: name,
        data: { my_price: my, competitor_price: competitor, diff_pct: round(diffPct, 1), seller, sku: product?.sku },
        summary_pt:  `${name} está ${round(diffPct, 1)}% acima de ${seller} ` +
                     `(R$ ${my.toFixed(2)} vs R$ ${competitor.toFixed(2)}).`,
        suggestion_pt: 'Avaliar reajuste pra ficar mais competitivo.',
        expires_at:  expiresAt,
      }
    }

    if (diffPct <= -10) {
      return {
        analyzer:    this.name,
        category:    'preco_competitivo',
        severity:    'info',
        score:       30,
        entity_type: 'product',
        entity_id:   productId,
        entity_name: name,
        data: { my_price: my, competitor_price: competitor, diff_pct: round(diffPct, 1), seller, sku: product?.sku },
        summary_pt:  `${name} está ${round(Math.abs(diffPct), 1)}% mais barato que ${seller} — ` +
                     `oportunidade de ajuste pra cima.`,
        suggestion_pt: `Considerar subir preço pra próximo de R$ ${competitor.toFixed(2)}.`,
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
