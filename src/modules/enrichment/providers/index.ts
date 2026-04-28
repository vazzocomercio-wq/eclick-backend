import { Provider } from '@nestjs/common'
import { BaseEnrichmentProvider } from './base-provider'
import { BigDataCorpProvider } from './bigdatacorp.provider'
import { DirectDataProvider } from './directdata.provider'
import { DataStoneProvider } from './datastone.provider'
import { AssertivaProvider } from './assertiva.provider'
import { HubDevProvider } from './hubdev.provider'
import { ViaCepProvider } from './viacep.provider'
import { PH3AProvider } from './ph3a.provider'

export * from './base-provider'

export const ALL_PROVIDERS: Provider[] = [
  BigDataCorpProvider,
  DirectDataProvider,
  DataStoneProvider,
  AssertivaProvider,
  HubDevProvider,
  ViaCepProvider,
  PH3AProvider,
]

/** Token used by the orchestrator to inject the full registry as a Map. */
export const ENRICHMENT_PROVIDERS = 'ENRICHMENT_PROVIDERS'

export const enrichmentRegistryProvider: Provider = {
  provide: ENRICHMENT_PROVIDERS,
  useFactory: (
    big: BigDataCorpProvider,
    dd:  DirectDataProvider,
    ds:  DataStoneProvider,
    ass: AssertivaProvider,
    hub: HubDevProvider,
    via: ViaCepProvider,
    ph3a: PH3AProvider,
  ): Map<string, BaseEnrichmentProvider> => {
    const m = new Map<string, BaseEnrichmentProvider>()
    for (const p of [big, dd, ds, ass, hub, via, ph3a]) m.set(p.code, p)
    return m
  },
  inject: [BigDataCorpProvider, DirectDataProvider, DataStoneProvider, AssertivaProvider, HubDevProvider, ViaCepProvider, PH3AProvider],
}
