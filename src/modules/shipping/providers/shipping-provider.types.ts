/**
 * Camada de frete platform-agnostic (F3).
 *
 * Cada transportadora vira um adaptador que implementa `ShippingProvider` e se
 * registra no `ShippingProviderRegistry` — "adicionar transportadora = 1 classe
 * + register, zero mudança no motor". Todos emitem o mesmo `ShipmentEvent`
 * normalizado, que (a partir da F4+) alimenta o funil dropship.
 */

export type ShipmentStatus =
  | 'created'
  | 'label_ready'   // etiqueta gerada — Camada 1
  | 'posted'        // postado/despachado — Camada 2a
  | 'in_transit'
  | 'delivered'
  | 'undelivered'
  | 'cancelled'

export type ShippingProviderName = 'manual' | 'melhor_envio' | 'frenet' | 'correios'

/** Evento normalizado de transportadora — a moeda comum do funil. */
export interface ShipmentEvent {
  provider:      ShippingProviderName
  status:        ShipmentStatus
  externalId?:   string   // id da etiqueta/envio no provider
  trackingCode?: string
  trackingUrl?:  string
  carrier?:      string
  service?:      string
  occurredAt?:   string   // ISO; default = agora
  freightCost?:  number
  raw?:          Record<string, unknown>
}

/** Contrato de cada adaptador de transportadora. */
export interface ShippingProvider {
  readonly name: ShippingProviderName
  /**
   * Normaliza um webhook do provider num ShipmentEvent (ou null pra ignorar).
   * Opcional — providers só-leitura/manuais podem não ter webhook.
   */
  parseWebhook?(
    headers: Record<string, string | undefined>,
    body: unknown,
  ): ShipmentEvent | null
}
