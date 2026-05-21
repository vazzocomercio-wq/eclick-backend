/**
 * Cupons da loja (D.1).
 *
 * 3 tipos:
 *  - percentage     → desconto % no subtotal (value = 1..100)
 *  - fixed          → desconto fixo R$ no subtotal (value em centavos)
 *  - free_shipping  → frete gratis (value ignorado)
 */

export type CouponType = 'percentage' | 'fixed' | 'free_shipping'

export interface Coupon {
  id:               string
  organization_id:  string
  code:             string
  type:             CouponType
  value:            number       // percent (1..100) ou centavos
  min_order_cents:  number
  usage_limit:      number | null
  used_count:       number
  expires_at:       string | null  // ISO
  active:           boolean
  description:      string | null
  created_at:       string
  updated_at:       string
}

export interface CouponApplied {
  code:                  string
  type:                  CouponType
  discount_cents:        number
  free_shipping:         boolean
  message:               string
}
