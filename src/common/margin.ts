/**
 * Cálculo CANÔNICO de margem de contribuição — fonte ÚNICA no sistema.
 *
 * Modelo do Mercado Livre (validado contra a tela de vendas do ML):
 *   Margem de Contribuição = Preço − Tarifa de venda − Frete − Custo − Imposto
 *   Margem (%)             = Margem ÷ Preço
 *
 * O imposto incide sobre o Preço — ou sobre Preço + Frete, quando
 * `taxOnFreight` é true.
 *
 * Esta função é PURA e recebe os componentes já resolvidos em R$. Quem chama
 * decide se a tarifa e o frete são valores REAIS (pedido concretizado) ou
 * ESTIMADOS (anúncio ainda não vendido) — ver `estimateSaleFee`.
 *
 * ⚠️ Espelho EXATO de `eclick-frontend/src/lib/margin.ts`. Qualquer mudança
 * aqui deve ser replicada lá (e vice-versa).
 */

export interface MarginInput {
  /** Preço de venda do item (R$). */
  price:         number
  /** Tarifa de venda do ML em R$ — valor real do pedido OU estimado. */
  saleFee:       number
  /** Frete pago pelo vendedor em R$ (0 quando o comprador paga). */
  shipping:      number
  /** Custo do produto em R$ (CMV). */
  cost:          number
  /** Percentual de imposto, escala 0–100 (ex: 8 = 8%). */
  taxPercentage: number
  /** Se true, o imposto incide sobre Preço + Frete; senão só sobre o Preço. */
  taxOnFreight:  boolean
}

export interface MarginResult {
  /** Valor do imposto em R$. */
  taxAmount:             number
  /** Margem de contribuição em R$. */
  contributionMargin:    number
  /** Margem de contribuição em % do preço (escala 0–100). */
  contributionMarginPct: number
}

/** Arredonda pra 2 casas decimais (centavos). */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * Cálculo canônico da margem de contribuição. Componentes negativos são
 * tratados como 0 — entrada inválida nunca infla a margem.
 */
export function computeContributionMargin(input: MarginInput): MarginResult {
  const price    = Math.max(0, Number(input.price)    || 0)
  const saleFee  = Math.max(0, Number(input.saleFee)  || 0)
  const shipping = Math.max(0, Number(input.shipping) || 0)
  const cost     = Math.max(0, Number(input.cost)     || 0)
  const taxPct   = Math.max(0, Number(input.taxPercentage) || 0)

  const taxBase   = input.taxOnFreight ? price + shipping : price
  const taxAmount = round2(taxBase * (taxPct / 100))

  const margin    = round2(price - saleFee - shipping - cost - taxAmount)
  const marginPct = price > 0 ? round2((margin / price) * 100) : 0

  return {
    taxAmount,
    contributionMargin:    margin,
    contributionMarginPct: marginPct,
  }
}

/**
 * Estima a tarifa de venda do ML (R$) a partir do percentual + custo fixo da
 * categoria — valores que vêm da API `listing_prices` (`sale_fee_details`).
 * Use APENAS quando não há `sale_fee` real do pedido.
 *
 * @param price         Preço de venda (R$)
 * @param percentageFee Percentual da tarifa, escala 0–100 (ex: 11.5)
 * @param fixedFee      Custo fixo da tarifa (R$) — itens ≤ R$79 no ML
 */
export function estimateSaleFee(price: number, percentageFee: number, fixedFee: number): number {
  const p   = Math.max(0, Number(price) || 0)
  const pct = Math.max(0, Number(percentageFee) || 0)
  const fix = Math.max(0, Number(fixedFee) || 0)
  return round2(p * (pct / 100) + fix)
}
