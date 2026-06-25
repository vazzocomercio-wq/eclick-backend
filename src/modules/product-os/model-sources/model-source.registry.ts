import { Injectable, BadRequestException } from '@nestjs/common'
import { type ModelSourceProvider, type SourceModel } from './source.types'
import { MakerworldService } from '../makerworld.service'
import { ThingiverseService } from '../thingiverse.service'
import { CultsService } from '../cults.service'

/**
 * Registry dos bancos de modelos 3D. Importar/Radar/Porteiro falam só com ele;
 * não conhecem plataforma. Resolve o provedor por URL (matchUrl) ou por chave
 * (platform). Adicionar plataforma = injetar o provedor aqui + push no array.
 */
@Injectable()
export class ModelSourceRegistry {
  private readonly providers: ModelSourceProvider[]

  constructor(
    private readonly makerworld: MakerworldService,
    private readonly thingiverse: ThingiverseService,
    private readonly cults: CultsService,
  ) {
    this.providers = [this.makerworld, this.thingiverse, this.cults]
  }

  /** Plataformas conhecidas (independente de estarem configuradas). */
  all(): ModelSourceProvider[] { return this.providers }

  /** Plataformas prontas pra uso (credencial ok). */
  configured(): ModelSourceProvider[] { return this.providers.filter(p => p.isConfigured()) }

  byPlatform(platform: string): ModelSourceProvider {
    const p = this.providers.find(x => x.platform === platform)
    if (!p) throw new BadRequestException(`Plataforma desconhecida: ${platform}`)
    return p
  }

  /** Resolve pelo link colado. Se não casar nenhuma URL, cai no MakerWorld
   *  (compat: IDs crus historicamente eram MakerWorld). */
  resolveByUrl(input: string): ModelSourceProvider {
    const hit = this.providers.find(p => p.matchUrl(input))
    return hit ?? this.makerworld
  }

  /** Lê e normaliza um modelo a partir de um link ou ID. */
  fetchByUrl(input: string): Promise<SourceModel> {
    const provider = this.resolveByUrl(input)
    if (!provider.isConfigured()) throw new BadRequestException(`A integração com ${provider.label} ainda não está configurada.`)
    return provider.fetchModel(input)
  }

  /** Lê um modelo de uma plataforma específica (usado pelo refresh do radar). */
  fetchByPlatform(platform: string, input: string): Promise<SourceModel> {
    const provider = this.byPlatform(platform)
    if (!provider.isConfigured()) throw new BadRequestException(`A integração com ${provider.label} ainda não está configurada.`)
    return provider.fetchModel(input)
  }
}
