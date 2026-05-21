/**
 * Frete polimorfico (D.2).
 *
 * 6 kinds:
 *  - fixed         → preço fixo em centavos
 *  - free          → grátis (com condições opcionais — ex.: min subtotal)
 *  - percentage    → % do subtotal
 *  - cep_range     → preço fixo pra CEPs entre cep_from e cep_to
 *  - weight_based  → R$ por kg
 *  - melhor_envio  → API externa (placeholder — sprint futura)
 */

export type ShippingKind = 'fixed' | 'free' | 'percentage' | 'cep_range' | 'weight_based' | 'melhor_envio'

export interface ShippingRule {
  id:                   string
  organization_id:      string
  kind:                 ShippingKind
  name:                 string
  priority:             number
  active:               boolean
  price_cents:          number
  percent_value:        number | null
  price_per_kg_cents:   number | null
  cep_from:             string | null
  cep_to:               string | null
  min_subtotal_cents:   number | null
  max_subtotal_cents:   number | null
  max_weight_kg:        number | null
  state_codes:          string[] | null
  delivery_min_days:    number | null
  delivery_max_days:    number | null
  created_at:           string
  updated_at:           string
}

export interface ShippingQuote {
  rule_id:           string
  name:              string
  price_cents:       number
  delivery_min_days: number | null
  delivery_max_days: number | null
  kind:              ShippingKind
}
