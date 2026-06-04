import { Injectable, Logger } from '@nestjs/common'
import type { ShippingProvider, ShippingProviderName } from './shipping-provider.types'

/**
 * Registro central de adaptadores de transportadora. Cada provider se registra
 * (geralmente no próprio construtor) e o resto do sistema resolve por nome.
 */
@Injectable()
export class ShippingProviderRegistry {
  private readonly logger = new Logger(ShippingProviderRegistry.name)
  private readonly providers = new Map<ShippingProviderName, ShippingProvider>()

  register(provider: ShippingProvider): void {
    this.providers.set(provider.name, provider)
    this.logger.log(`[shipping] provider registrado: ${provider.name}`)
  }

  get(name: string): ShippingProvider | undefined {
    return this.providers.get(name as ShippingProviderName)
  }

  list(): ShippingProvider[] {
    return [...this.providers.values()]
  }
}
