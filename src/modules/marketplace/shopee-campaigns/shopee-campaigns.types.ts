/** F18 F1.4 — Tipos do Shopee Campaign Center.
 *
 *  3 tipos de campanha:
 *  - voucher       — código de desconto (publicado por canal: feed/produto/loja)
 *  - flash_sale    — preço promocional janela curta com desconto fixo
 *  - ads           — boost de produto (Shopee Ads keyword/discovery)
 *
 *  ROI = (revenue - cost) / cost. Para flash/voucher, cost = desconto ×
 *  vendas. Para ads, cost = gasto Shopee Ads. Revenue = total vendido na
 *  janela atribuído à campanha.
 *
 *  Margin gate (futuro F1.6): bloqueia ativação se margem pós-comissão
 *  < threshold da org. Por ora apenas calcula e expõe a margem projetada
 *  pra UI mostrar warning não-bloqueante.
 */

export type CampaignKind   = 'voucher' | 'flash_sale' | 'ads'
export type CampaignStatus = 'planned' | 'active' | 'paused' | 'ended' | 'cancelled'

/** Config específica por tipo (kind). Genérico JSONB no DB; type-narrowing
 *  no service por kind. */
export interface VoucherConfig {
  code?:          string | null      // null = codeless (auto-aplicado)
  discount_type:  'fixed' | 'percent'
  discount_value: number              // fixed em centavos, percent em 0-1
  min_spend?:     number | null       // centavos
  channel?:       'feed' | 'product' | 'shop' | 'live'
  usage_limit?:   number | null       // null = ilimitado
}

export interface FlashSaleConfig {
  /** SKUs/item_ids participantes. Vazio = todos da loja. */
  item_ids:        number[]
  discount_type:   'fixed' | 'percent'
  discount_value:  number
}

export interface AdsConfig {
  ad_type:       'product' | 'discovery' | 'keyword'
  budget_cents:  number
  /** Boost pra estes item_ids; vazio = automático. */
  item_ids?:     number[]
  keywords?:     string[]            // para ad_type='keyword'
}

export type CampaignConfig =
  | { kind: 'voucher';    voucher:    VoucherConfig }
  | { kind: 'flash_sale'; flash_sale: FlashSaleConfig }
  | { kind: 'ads';        ads:        AdsConfig }

export interface CampaignMetrics {
  revenue_cents:    number
  cost_cents:       number
  orders:           number
  views?:           number          // só ads
  clicks?:          number          // só ads
}

export interface CampaignCard {
  id:                 string
  organization_id:    string
  shop_id:            number
  shop_name?:         string | null
  kind:               CampaignKind
  status:             CampaignStatus
  title:              string
  config:             Record<string, unknown>      // typed inside service
  starts_at:          string                       // ISO
  ends_at:            string | null                // ISO ou null pra evergreen
  metrics:            CampaignMetrics
  roi:                number | null                // (rev - cost) / cost
  margin_warning?:    string | null                // texto se margem < threshold
  created_at:         string
  updated_at:         string
}
