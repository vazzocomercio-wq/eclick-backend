/** Loja Propria — Frente C: tipos do modulo payments. */

export type Gateway = 'mercadopago' | 'stripe'

export interface CheckoutItem {
  productId: string
  name:      string
  price:     number
  qty:       number
  imageUrl?: string
}

export interface CheckoutCustomer {
  name:    string
  email:   string
  phone?:  string
  doc?:    string          // CPF ou CNPJ
  address?: Record<string, unknown>
  notes?:  string
}

export interface StorefrontOrder {
  id:                 string
  organization_id:    string
  store_slug:         string
  customer:           CheckoutCustomer
  items:              CheckoutItem[]
  subtotal:           number
  shipping:           number
  total:              number
  gateway:            Gateway | null
  gateway_session_id: string | null
  gateway_payment_id: string | null
  gateway_init_point: string | null
  status: 'pending' | 'awaiting_payment' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'refunded'
  raw_callback:       unknown
  created_at:         string
  updated_at:         string
}

export interface GatewayCheckoutResult {
  /** id da preference/session no gateway — usado depois pelo webhook pra match. */
  sessionId:  string
  /** URL final pra redirect do usuario. */
  initPoint:  string
}
