// Shapes da API ML que consumimos. Cobre só o subset usado pelo módulo.

export interface MlPackMessagesResponse {
  paging?: { total?: number; offset?: number; limit?: number }
  messages: MlPackMessage[]
}

export interface MlPackMessage {
  id:           string
  from:         { user_id: number }
  to:           { user_id: number }
  text:         string
  message_date: { received?: string; available?: string; notified?: string; created?: string; read?: string }
  status?:      string
  message_attachments?: Array<{ filename?: string; original_filename?: string; type?: string; status?: string }>
  message_moderation?: { status?: string; reason?: string }
}

export interface MlPackResponse {
  pack_id?:        string | number
  id?:             string | number
  status?:         string
  buyer?:          { id?: number; nickname?: string }
  order_id?:       number | string
  order_ids?:      Array<{ id: number; status?: string }>
}

export interface MlOrderSummary {
  id:                number
  status?:           string
  total_amount?:     number
  date_created?:     string
  buyer?:            { id?: number; nickname?: string }
  shipping?:         { id?: number; status?: string; estimated_delivery?: string; tracking_number?: string }
  order_items?:      Array<{
    item?: { id?: string; title?: string; thumbnail?: string }
    quantity?: number
  }>
}

export interface ConversationContextSnapshot {
  conversationId:        string
  organizationId:        string
  packId:                number
  orderId?:              number
  buyerNickname?:        string
  productTitle?:         string
  productThumbnail?:     string
  shippingStatus?:       string
  estimatedDelivery?:    string
  orderTotal?:           number
}
