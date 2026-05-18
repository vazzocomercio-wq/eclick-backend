/**
 * Sessão 2026-05-18 — Cálculo do custo líquido a partir do preço bruto do
 * fornecedor (preço de venda dele). Usado pela sincronização Icarus e pelo
 * recálculo quando o desconto geral ou o ajuste por produto muda.
 *
 * Modelo: nunca enviamos preço de volta pro fornecedor — o ajuste é só nosso.
 */

export type CostAdjustmentType = 'percent' | 'fixed' | 'override'

export interface CostAdjustment {
  type:  CostAdjustmentType | null
  value: number | null
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Resolve qual ajuste vale: o do próprio produto (se tiver `type` definido)
 * ou o desconto geral do fornecedor.
 */
export function resolveAdjustment(
  productAdj: CostAdjustment,
  supplierDefault: CostAdjustment,
): CostAdjustment {
  return productAdj.type ? productAdj : supplierDefault
}

/**
 * Custo líquido = preço bruto do fornecedor menos o ajuste.
 *   - percent:  bruto × (1 − valor/100)
 *   - fixed:    bruto − valor (R$)
 *   - override: valor (custo digitado direto; o bruto vira só referência)
 *   - sem tipo: bruto sem desconto
 * Nunca retorna negativo.
 */
export function computeNetCost(grossPrice: number | null | undefined, adj: CostAdjustment): number {
  const gross = Number(grossPrice) || 0
  const value = Number(adj.value) || 0
  let net: number
  switch (adj.type) {
    case 'percent':  net = gross * (1 - value / 100); break
    case 'fixed':    net = gross - value;             break
    case 'override': net = value;                     break
    default:         net = gross
  }
  return round2(Math.max(0, net))
}
