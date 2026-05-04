import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { BaseAnalyzer } from './base.analyzer'
import type { AnalyzerName, SignalDraft } from './analyzers.types'

const WINDOW_DAYS_30 = 30
const WINDOW_DAYS_7  = 7

const RUPTURA_THRESHOLD_DAYS = 7
const BAIXO_THRESHOLD_DAYS   = 15
const ALTO_THRESHOLD_DAYS    = 90
const ALTO_MAX_VELOCITY      = 0.5  // unidades/dia — abaixo disso é parado

const COBERTURA_ALVO_DAYS    = 30  // sugestão de compra mira 30d

const SIGNAL_TTL_HOURS       = 24

interface ProductRow {
  id:          string
  name:        string | null
  sku:         string | null
  supply_type: string | null
}

/**
 * EstoqueAnalyzer — primeiro analyzer end-to-end.
 *
 * Para cada produto da org com estoque cadastrado:
 *   1. velocity_30d = vendas_30d / 30
 *   2. velocity_7d  = vendas_7d  / 7
 *   3. velocity     = max(velocity_7d, velocity_30d * 0.7)  // evita zerar quando hot
 *   4. days_of_stock = current_stock / max(velocity, 0.01)
 *
 * Buckets:
 *   days <= 7              → ruptura_iminente   (critical, score 85-100)
 *   days <= 15             → estoque_baixo      (warning,  score 50-79)
 *   days >  90 + vel baixa → estoque_alto       (info,     score 40)
 *   stock > 0 + vel == 0   → sem_movimento      (info,     score 30)
 *
 * Não emite sinal se já existe signal recente (24h) pro mesmo product+category.
 */
@Injectable()
export class EstoqueAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'estoque'

  async scan(orgId: string): Promise<SignalDraft[]> {
    // 1. Produtos da org
    const { data: products, error: pErr } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, supply_type')
      .eq('organization_id', orgId)
    if (pErr) {
      this.logger.error(`[estoque] org=${orgId} produtos: ${pErr.message}`)
      return []
    }

    const productIds = (products ?? []).map((p: ProductRow) => p.id)
    if (productIds.length === 0) {
      this.logger.log(`[estoque] org=${orgId} sem produtos`)
      return []
    }
    const productMap = new Map<string, ProductRow>(
      (products ?? []).map((p: ProductRow) => [p.id, p]),
    )

    // 2. Estoque atual (soma se múltiplas linhas por produto)
    const { data: stockRows, error: sErr } = await supabaseAdmin
      .from('product_stock')
      .select('product_id, quantity')
      .in('product_id', productIds)
    if (sErr) {
      this.logger.error(`[estoque] org=${orgId} estoque: ${sErr.message}`)
      return []
    }
    const stockMap = new Map<string, number>()
    for (const row of stockRows ?? []) {
      stockMap.set(row.product_id, (stockMap.get(row.product_id) ?? 0) + Number(row.quantity ?? 0))
    }

    // 3. Vendas dos últimos 30d (uma query, agregamos em memória)
    const since30 = new Date(Date.now() - WINDOW_DAYS_30 * 86_400_000).toISOString()
    const since7  = new Date(Date.now() - WINDOW_DAYS_7  * 86_400_000).toISOString()

    const { data: orders, error: oErr } = await supabaseAdmin
      .from('orders')
      .select('product_id, quantity, sold_at')
      .eq('organization_id', orgId)
      .gte('sold_at', since30)
      .in('product_id', productIds)
    if (oErr) {
      this.logger.error(`[estoque] org=${orgId} orders: ${oErr.message}`)
      return []
    }

    const salesMap = new Map<string, { q7: number; q30: number }>()
    for (const o of orders ?? []) {
      if (!o.product_id) continue
      const e = salesMap.get(o.product_id) ?? { q7: 0, q30: 0 }
      const qty = Number(o.quantity ?? 0)
      e.q30 += qty
      if ((o.sold_at as string) >= since7) e.q7 += qty
      salesMap.set(o.product_id, e)
    }

    // 4. Avaliar cada produto
    const drafts: SignalDraft[] = []
    const expiresAt = new Date(Date.now() + SIGNAL_TTL_HOURS * 3_600_000).toISOString()

    for (const [productId, prod] of productMap) {
      const stock = stockMap.get(productId) ?? 0
      if (stock <= 0) continue   // sem estoque, sem alerta — pode ser produto descontinuado

      const sales = salesMap.get(productId) ?? { q7: 0, q30: 0 }
      const v30 = sales.q30 / WINDOW_DAYS_30
      const v7  = sales.q7  / WINDOW_DAYS_7
      const velocity = Math.max(v7, v30 * 0.7)

      // sem movimento: tem estoque mas não vende
      if (velocity === 0) {
        drafts.push(this.buildSemMovimentoSignal(prod, stock, expiresAt))
        continue
      }

      const daysOfStock = stock / velocity

      if (daysOfStock <= RUPTURA_THRESHOLD_DAYS) {
        drafts.push(this.buildRupturaSignal(prod, stock, velocity, daysOfStock, expiresAt))
      } else if (daysOfStock <= BAIXO_THRESHOLD_DAYS) {
        drafts.push(this.buildEstoqueBaixoSignal(prod, stock, velocity, daysOfStock, expiresAt))
      } else if (daysOfStock > ALTO_THRESHOLD_DAYS && velocity < ALTO_MAX_VELOCITY) {
        drafts.push(this.buildEstoqueAltoSignal(prod, stock, velocity, daysOfStock, expiresAt))
      }
    }

    this.logger.log(`[estoque] org=${orgId} produtos=${productIds.length} signals=${drafts.length}`)
    return drafts
  }

  // ── Builders ────────────────────────────────────────────────────────────────

  private displayName(p: ProductRow): string {
    return p.name?.trim() || p.sku || `Produto ${p.id.slice(0, 8)}`
  }

  private buildRupturaSignal(
    p: ProductRow, stock: number, velocity: number, daysOfStock: number, expiresAt: string,
  ): SignalDraft {
    const score = Math.max(80, Math.min(100, Math.round(100 - daysOfStock * 3)))
    const reorderQty = Math.ceil(velocity * COBERTURA_ALVO_DAYS) - stock
    return {
      analyzer:    this.name,
      category:    'ruptura_iminente',
      severity:    'critical',
      score,
      entity_type: 'product',
      entity_id:   p.id,
      entity_name: this.displayName(p),
      data: {
        stock,
        velocity_per_day: round2(velocity),
        days_of_stock:    round2(daysOfStock),
        reorder_qty:      Math.max(0, reorderQty),
        supply_type:      p.supply_type,
        sku:              p.sku,
      },
      summary_pt: `Ruptura iminente: ${this.displayName(p)} acaba em ${round1(daysOfStock)} dias ` +
                  `(estoque ${stock}u, vende ${round2(velocity)}/dia).`,
      suggestion_pt: reorderQty > 0
        ? `Comprar urgente ~${reorderQty}u pra cobrir ${COBERTURA_ALVO_DAYS} dias.`
        : 'Estoque suficiente pra cobertura alvo — confirmar reposição.',
      expires_at: expiresAt,
    }
  }

  private buildEstoqueBaixoSignal(
    p: ProductRow, stock: number, velocity: number, daysOfStock: number, expiresAt: string,
  ): SignalDraft {
    const score = Math.max(50, Math.min(79, Math.round(85 - daysOfStock * 1.5)))
    const reorderQty = Math.ceil(velocity * COBERTURA_ALVO_DAYS) - stock
    return {
      analyzer:    this.name,
      category:    'estoque_baixo',
      severity:    'warning',
      score,
      entity_type: 'product',
      entity_id:   p.id,
      entity_name: this.displayName(p),
      data: {
        stock,
        velocity_per_day: round2(velocity),
        days_of_stock:    round2(daysOfStock),
        reorder_qty:      Math.max(0, reorderQty),
        supply_type:      p.supply_type,
        sku:              p.sku,
      },
      summary_pt: `Estoque baixo: ${this.displayName(p)} cobre ${round1(daysOfStock)} dias ` +
                  `(${stock}u em estoque, vende ${round2(velocity)}/dia).`,
      suggestion_pt: reorderQty > 0
        ? `Comprar ~${reorderQty}u pra cobrir ${COBERTURA_ALVO_DAYS} dias.`
        : null,
      expires_at: expiresAt,
    }
  }

  private buildEstoqueAltoSignal(
    p: ProductRow, stock: number, velocity: number, daysOfStock: number, expiresAt: string,
  ): SignalDraft {
    return {
      analyzer:    this.name,
      category:    'estoque_alto',
      severity:    'info',
      score:       40,
      entity_type: 'product',
      entity_id:   p.id,
      entity_name: this.displayName(p),
      data: {
        stock,
        velocity_per_day: round2(velocity),
        days_of_stock:    Math.round(daysOfStock),
        sku:              p.sku,
      },
      summary_pt: `Estoque parado: ${this.displayName(p)} tem ${stock}u (~${Math.round(daysOfStock)} dias) ` +
                  `e vende só ${round2(velocity)}/dia.`,
      suggestion_pt: 'Avaliar promoção, desconto ou ajuste de preço pra escoar.',
      expires_at: expiresAt,
    }
  }

  private buildSemMovimentoSignal(
    p: ProductRow, stock: number, expiresAt: string,
  ): SignalDraft {
    return {
      analyzer:    this.name,
      category:    'sem_movimento',
      severity:    'info',
      score:       30,
      entity_type: 'product',
      entity_id:   p.id,
      entity_name: this.displayName(p),
      data: {
        stock,
        velocity_per_day: 0,
        days_of_stock:    null,
        sku:              p.sku,
      },
      summary_pt: `Sem movimento: ${this.displayName(p)} tem ${stock}u em estoque ` +
                  `e nenhuma venda nos últimos ${WINDOW_DAYS_30} dias.`,
      suggestion_pt: 'Considerar descontinuar ou liquidar.',
      expires_at: expiresAt,
    }
  }
}

function round1(n: number) { return Math.round(n * 10) / 10 }
function round2(n: number) { return Math.round(n * 100) / 100 }
