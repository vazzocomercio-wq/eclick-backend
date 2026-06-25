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

  /** Lista os modelos de um criador numa plataforma (se suportar). */
  listByCreator(platform: string, handle: string, limit?: number): Promise<SourceModel[]> {
    const provider = this.byPlatform(platform)
    if (!provider.isConfigured()) throw new BadRequestException(`A integração com ${provider.label} ainda não está configurada.`)
    if (!provider.listByCreator) throw new BadRequestException(`${provider.label} não suporta busca por criador.`)
    return provider.listByCreator(handle, limit)
  }

  /** Feed de descoberta / "em alta" de uma plataforma (se suportar). */
  discover(platform: string, opts?: { commercialOnly?: boolean; categorySlug?: string; sort?: 'downloads' | 'recent'; limit?: number; offset?: number }): Promise<SourceModel[]> {
    const provider = this.byPlatform(platform)
    if (!provider.isConfigured()) throw new BadRequestException(`A integração com ${provider.label} ainda não está configurada.`)
    if (!provider.discover) throw new BadRequestException(`${provider.label} não tem feed de descoberta.`)
    return provider.discover(opts)
  }

  /** Categorias de uma plataforma (se suportar). */
  listCategories(platform: string): Promise<{ slug: string; name: string }[]> {
    const provider = this.byPlatform(platform)
    if (!provider.isConfigured()) throw new BadRequestException(`A integração com ${provider.label} ainda não está configurada.`)
    if (!provider.listCategories) throw new BadRequestException(`${provider.label} não expõe categorias.`)
    return provider.listCategories()
  }

  /** Busca por palavra-chave numa plataforma (se suportar). */
  search(platform: string, query: string, opts?: { commercialOnly?: boolean; limit?: number }): Promise<SourceModel[]> {
    const provider = this.byPlatform(platform)
    if (!provider.isConfigured()) throw new BadRequestException(`A integração com ${provider.label} ainda não está configurada.`)
    if (!provider.search) throw new BadRequestException(`${provider.label} não suporta busca por palavra.`)
    return provider.search(query, opts)
  }

  /** Refs leves dos modelos recentes de um criador (p/ cron de novidades). */
  listCreatorRefs(platform: string, handle: string, limit?: number): Promise<{ external_id: string; title: string; source_url: string }[]> {
    const provider = this.byPlatform(platform)
    if (!provider.isConfigured() || !provider.listCreatorRefs) return Promise.resolve([])
    return provider.listCreatorRefs(handle, limit)
  }

  /** Plataformas configuradas que suportam cada capacidade (pra UI). */
  creatorPlatforms() { return this.configured().filter(p => !!p.listByCreator).map(p => ({ platform: p.platform, label: p.label })) }
  discoverPlatforms() { return this.configured().filter(p => !!p.discover).map(p => ({ platform: p.platform, label: p.label })) }
}
