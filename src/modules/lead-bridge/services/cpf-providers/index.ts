import { EnrichmentProvider } from './types'
import { BigDataCorpProvider } from './bigdatacorp.provider'
import { DirectDataProvider } from './directd.provider'
import { DataStoneProvider } from './datastone.provider'
import { AssertivaProvider } from './assertiva.provider'
import { HubDesenvolvedorProvider } from './hubdesenvolvedor.provider'

export * from './types'

const PROVIDERS: Record<string, EnrichmentProvider> = {
  bigdatacorp:      new BigDataCorpProvider(),
  directd:          new DirectDataProvider(),
  datastone:        new DataStoneProvider(),
  assertiva:        new AssertivaProvider(),
  hubdesenvolvedor: new HubDesenvolvedorProvider(),
}

export function getProvider(id: string): EnrichmentProvider | null {
  return PROVIDERS[id?.toLowerCase()] ?? null
}

export const PROVIDER_IDS = Object.keys(PROVIDERS)
