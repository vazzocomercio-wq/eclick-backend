import { Injectable } from '@nestjs/common'
import { ShippingProviderRegistry } from './shipping-provider.registry'
import type { ShippingProvider } from './shipping-provider.types'

/**
 * Provider de fallback (sempre disponível): o operador/parceiro informa a
 * transportadora e o código de rastreio manualmente. Não tem webhook — os
 * eventos entram via `ShipmentsService.recordEvent`. Prova o padrão de
 * adaptadores enquanto Melhor Envio (F4) / Frenet / Correios não chegam.
 */
@Injectable()
export class ManualProvider implements ShippingProvider {
  readonly name = 'manual' as const

  constructor(registry: ShippingProviderRegistry) {
    registry.register(this)
  }
}
