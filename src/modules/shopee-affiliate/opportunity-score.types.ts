/** F18 F2.3 — Opportunity Score (lado Afiliado).
 *
 *  PRINCÍPIO CENTRAL: ranquear por comissão pura ENGANA. Comissão alta em
 *  produto que não vende é armadilha — o afiliado gasta tráfego e não
 *  converte, ou pior: converte e o cliente devolve (devolução cancela a
 *  comissão Shopee).
 *
 *  Opportunity Score combina 4 fatores:
 *    commission × conversion × seller_reputation × trend
 *
 *  + FILTRO DE SAÍDA: rating < 4.5 OU reputação de vendedor baixa = OUT
 *  (não vale promover — risco de devolução/cancelamento alto).
 */

export interface AffiliateOfferInput {
  item_id:          number
  shop_id?:         number | null
  name?:            string | null
  category?:        string | null
  price_cents?:     number | null

  /** Comissão da Affiliate API. 0-1 (ex: 0.12 = 12%). Shopee BR média
   *  3-15%, bônus de campanha até 80%. */
  commission_rate:  number

  /** Nota do produto/anúncio 0-5. Proxy primário de satisfação. */
  rating?:          number | null

  /** Volume de vendas (unidades) — proxy de conversão comprovada. */
  sales_volume?:    number | null

  /** Reputação do vendedor 0-100 (da loja). Baixa = risco devolução. */
  seller_score?:    number | null

  /** Sinal de tendência 0-100 (do Radar F1.5 — categoria em alta). */
  trend_score?:     number | null
}

export interface OpportunityBreakdown {
  /** Score final 0-100. Se excluded=true, vem 0. */
  score:        number
  /** Sub-componentes (0-100) pra UI/auditoria. */
  components: {
    commission:  number
    conversion:  number
    seller:      number
    trend:       number
  }
  /** true = reprovado no filtro de saída (rating<4.5 ou seller fraco). */
  excluded:     boolean
  /** Motivo da exclusão (PT-BR) se excluded. */
  exclude_reason: string | null
  /** Estimativa de conversão derivada (0-1) — útil pra projeção de receita. */
  conv_estimate: number
}

/** Pesos do Opportunity Score. Cravados — mudança = mudança de modelo. */
export const OPPORTUNITY_WEIGHTS = {
  commission: 0.30,
  conversion: 0.30,
  seller:     0.25,
  trend:      0.15,
} as const

/** Thresholds do filtro de saída. */
export const OPPORTUNITY_GATES = {
  min_rating:        4.5,   // abaixo = OUT
  min_seller_score:  40,    // abaixo = OUT
} as const
