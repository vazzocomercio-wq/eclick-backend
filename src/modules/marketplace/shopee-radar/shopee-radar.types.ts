/** F18 F1.5 — Tipos do Radar Shopee.
 *
 *  Coletor de tendências de mercado. 3 tipos de sinal:
 *  - trending        — produto/categoria em alta (volume de busca/vendas)
 *  - price_benchmark — preço médio do líder vs mediana do mercado
 *  - fbs_adoption    — % de vendedores com Frete Grátis Shopee na categoria
 *
 *  Granularidade dual: por categoria (sempre) + por item_id (opcional, pra
 *  benchmarks contra concorrente direto).
 *
 *  Coletor real entra na Sprint 2 com creds Open Platform aprovadas.
 *  Active radar (módulo `radar` no eclick-active) consumirá via bridge view
 *  `active.v_saas_shopee_signals` — implementação cross-repo futura.
 */

export type SignalType = 'trending' | 'price_benchmark' | 'fbs_adoption'

export interface SignalPayload {
  /** Texto humano resumindo o sinal (pra UI mostrar direto). */
  summary?: string
  /** Direção da tendência: 'up' | 'down' | 'flat'. */
  trend?:   'up' | 'down' | 'flat'
  /** Δ % vs período anterior (-1 a +N). */
  delta?:   number
  /** Detalhes do líder em price_benchmark. */
  leader?:  {
    shop_id?:    number
    title?:      string
    price_cents: number
    rating?:     number | null
    is_fbs?:     boolean
  }
  /** Distribuição em fbs_adoption: { fbs_count, total_count }. */
  fbs?:     { count: number; total: number }
  /** Top items pra trending (com nome + venda estimada). */
  top?:     Array<{ item_id?: number; title?: string; estimated_sales_7d?: number }>
  /** Métricas extras platform-specific (ex: views, search_volume). */
  extras?:  Record<string, number | string>
}

export interface MarketSignal {
  id:                string
  organization_id:   string
  signal_type:       SignalType
  category_id:       number              // Shopee category_id (~root ou folha)
  category_name:    string | null
  item_id:           number | null
  /** Valor numérico principal — interpretação depende do tipo:
   *  - trending        → score 0-100
   *  - price_benchmark → preço líder em centavos
   *  - fbs_adoption    → ratio 0-1
   */
  metric_value:      number
  payload:           SignalPayload
  captured_at:       string              // ISO
}

export interface RadarSummary {
  trending:        MarketSignal[]
  price_benchmark: MarketSignal[]
  fbs_adoption:    MarketSignal[]
}
