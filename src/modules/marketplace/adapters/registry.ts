import { Injectable, NotImplementedException } from '@nestjs/common'
import { MarketplaceAdapter, MarketplacePlatform } from './base'
import { MercadoLivreAdapter } from './ml.adapter'
import { MagaluAdapter } from './magalu.adapter'

/** DI registry — keya adapters por platform. Sprint C2.3 vai registrar
 * ShopeeAdapter aqui. Lookup é estático (constructor injection dos adapters
 * → Map). Throw NotImplementedException pra plataformas ainda não codificadas
 * → frontend mostra "Em breve" sem crashar. */
@Injectable()
export class MarketplaceAdapterRegistry {
  private readonly adapters: Map<MarketplacePlatform, MarketplaceAdapter>

  constructor(ml: MercadoLivreAdapter, magalu: MagaluAdapter) {
    this.adapters = new Map<MarketplacePlatform, MarketplaceAdapter>([
      ['mercadolivre', ml],
      ['magalu',       magalu],
    ])
  }

  /** Retorna adapter ou throw se a platform ainda não tem implementação. */
  get(platform: MarketplacePlatform): MarketplaceAdapter {
    const a = this.adapters.get(platform)
    if (!a) throw new NotImplementedException(
      `Adapter pra '${platform}' ainda não implementado. ` +
      `Plataformas disponíveis: ${[...this.adapters.keys()].join(', ')}`,
    )
    return a
  }

  /** Helper booleano pro frontend exibir "Em breve" vs "Conectar". */
  isImplemented(platform: MarketplacePlatform): boolean {
    return this.adapters.has(platform)
  }

  /** Lista platforms já wirados (cresce com C2.2/C2.3). */
  listImplemented(): MarketplacePlatform[] {
    return [...this.adapters.keys()]
  }
}
