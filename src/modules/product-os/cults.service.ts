import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { type ModelSourceProvider, type SourceModel, buildVerdict } from './model-sources/source.types'

/**
 * Cults3D — provedor via GraphQL OFICIAL. A fonte mais valiosa: é a única que
 * vende LICENÇA COMERCIAL nativamente (direito legal de imprimir e vender), o
 * que destrava o gargalo do porteiro (Peça 2).
 *
 * Auth: HTTP Basic `base64(username:api_key)` no endpoint https://cults3d.com/graphql.
 * Credencial em `CULTS_API_USERNAME` + `CULTS_API_KEY` (gerar em
 * cults3d.com/en/api/keys). DORMENTE até as envs.
 *
 * Schema validado por introspection ao vivo (2026-06-25): `creation(slug: String!)`,
 * `License.allowsCommercialUse` é o sinal comercial autoritativo → veredito real
 * (verde quando comercial, amarelo quando uso privado). Modelo pago de "Private
 * Use" = amarelo; o lojista compra a licença comercial e libera no porteiro.
 */

const ENDPOINT = 'https://cults3d.com/graphql'

@Injectable()
export class CultsService implements ModelSourceProvider {
  readonly platform = 'cults3d'
  readonly label = 'Cults3D'
  private readonly logger = new Logger(CultsService.name)

  private creds(): { user: string; key: string } | null {
    const user = process.env.CULTS_API_USERNAME?.trim()
    const key = process.env.CULTS_API_KEY?.trim()
    return user && key ? { user, key } : null
  }
  isConfigured(): boolean { return !!this.creds() }

  matchUrl(input: string): boolean { return /cults3d\.com/i.test(input ?? '') }

  /** Da URL do Cults extrai o SLUG (último segmento de /3d-model/cat/slug). */
  parseSlug(input: string): string {
    const raw = (input ?? '').trim()
    if (!raw) throw new BadRequestException('Informe o link do modelo Cults3D.')
    const m = raw.match(/3d-model\/[^/]+\/([^/?#]+)/i)
    if (m) return m[1]
    // último segmento não-vazio como fallback
    const seg = raw.split('?')[0].split('#')[0].split('/').filter(Boolean).pop()
    if (seg) return seg
    throw new BadRequestException('Link Cults3D inválido. Cole a URL do modelo (ex: cults3d.com/en/3d-model/.../slug).')
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const c = this.creds()
    if (!c) throw new BadRequestException('Integração Cults3D não configurada (defina CULTS_API_USERNAME e CULTS_API_KEY).')
    const auth = Buffer.from(`${c.user}:${c.key}`).toString('base64')
    const { data } = await axios.post(ENDPOINT, { query, variables }, {
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15000,
      validateStatus: s => s === 200,
    })
    if (data?.errors?.length) throw new BadRequestException(`Cults3D: ${data.errors[0]?.message ?? 'erro GraphQL'}`)
    return data?.data as T
  }

  async fetchModel(input: string): Promise<SourceModel> {
    if (!this.isConfigured()) throw new BadRequestException('Integração Cults3D não configurada (defina CULTS_API_USERNAME e CULTS_API_KEY).')
    const slug = this.parseSlug(input)
    const query = `query($slug: String!) { creation(slug: $slug) { ${CREATION_FIELDS} } }`
    let creation: Record<string, any> | null = null
    try {
      const out = await this.gql<{ creation: Record<string, any> }>(query, { slug })
      creation = out?.creation ?? null
    } catch (e) {
      this.logger.warn(`[cults3d] busca por slug "${slug}" falhou: ${(e as Error).message}`)
      throw new BadRequestException('Não consegui ler o Cults3D agora (confirme a chave da API e o link).')
    }
    if (!creation) throw new NotFoundException('Modelo não encontrado no Cults3D.')
    return this.normalize(slug, creation)
  }

  /** Modelos de um criador, mais baixados primeiro (`creationsSearchBatch`). */
  async listByCreator(handle: string, limit = 24): Promise<SourceModel[]> {
    if (!this.isConfigured()) throw new BadRequestException('Integração Cults3D não configurada.')
    const nick = (handle ?? '').replace(/^@/, '').trim()
    if (!nick) throw new BadRequestException('Informe o nick do criador no Cults3D.')
    const query = `query($nick: String!, $limit: Int!) {
      creationsSearchBatch(query: "", creatorNick: $nick, sort: BY_DOWNLOADS, limit: $limit) {
        results { ${CREATION_FIELDS} }
      }
    }`
    const out = await this.gql<{ creationsSearchBatch: { results: Record<string, any>[] } }>(query, { nick, limit: Math.min(50, Math.max(1, limit)) })
    return (out?.creationsSearchBatch?.results ?? []).map(c => this.normalize(c.slug, c))
  }

  /** Feed "em alta" — mais baixados; filtros opcionais por comercial e categoria. */
  async discover(opts: { commercialOnly?: boolean; categorySlug?: string; limit?: number; offset?: number } = {}): Promise<SourceModel[]> {
    if (!this.isConfigured()) throw new BadRequestException('Integração Cults3D não configurada.')
    const limit = Math.min(50, Math.max(1, opts.limit ?? 24))
    const offset = Math.max(0, opts.offset ?? 0)
    const query = `query($limit: Int!, $offset: Int!, $onlyCommercial: Boolean, $cat: String) {
      creationsBatch(sort: BY_DOWNLOADS, direction: DESC, limit: $limit, offset: $offset, onlyCommercial: $onlyCommercial, categorySlugEn: $cat) {
        results { ${CREATION_FIELDS} }
      }
    }`
    const out = await this.gql<{ creationsBatch: { results: Record<string, any>[] } }>(query, { limit, offset, onlyCommercial: opts.commercialOnly ?? false, cat: opts.categorySlug || null })
    return (out?.creationsBatch?.results ?? []).map(c => this.normalize(c.slug, c))
  }

  /** Lista LEVE dos modelos mais RECENTES do criador (p/ detectar novidades). */
  async listCreatorRefs(handle: string, limit = 50): Promise<{ external_id: string; title: string; source_url: string }[]> {
    if (!this.isConfigured()) throw new BadRequestException('Integração Cults3D não configurada.')
    const nick = (handle ?? '').replace(/^@/, '').trim()
    if (!nick) throw new BadRequestException('Informe o nick do criador.')
    const query = `query($nick: String!, $limit: Int!) {
      creationsSearchBatch(query: "", creatorNick: $nick, sort: BY_PUBLICATION, limit: $limit) {
        results { slug name url }
      }
    }`
    const out = await this.gql<{ creationsSearchBatch: { results: Array<{ slug: string; name: string; url: string }> } }>(query, { nick, limit: Math.min(50, Math.max(1, limit)) })
    return (out?.creationsSearchBatch?.results ?? []).map(c => ({ external_id: c.slug, title: c.name, source_url: c.url || `https://cults3d.com/en/3d-model/${c.slug}` }))
  }

  /** Busca por palavra-chave nos 3,4M modelos, mais baixados primeiro. */
  async search(query: string, opts: { commercialOnly?: boolean; limit?: number } = {}): Promise<SourceModel[]> {
    if (!this.isConfigured()) throw new BadRequestException('Integração Cults3D não configurada.')
    const q = (query ?? '').trim()
    if (!q) throw new BadRequestException('Informe o termo de busca.')
    const limit = Math.min(50, Math.max(1, opts.limit ?? 24))
    const gqlQuery = `query($q: String!, $limit: Int!, $onlyCommercial: Boolean) {
      creationsSearchBatch(query: $q, onlyCommercial: $onlyCommercial, sort: BY_DOWNLOADS, limit: $limit) {
        results { ${CREATION_FIELDS} }
      }
    }`
    const out = await this.gql<{ creationsSearchBatch: { results: Record<string, any>[] } }>(gqlQuery, { q, limit, onlyCommercial: opts.commercialOnly ?? false })
    return (out?.creationsSearchBatch?.results ?? []).map(c => this.normalize(c.slug, c))
  }

  /** Árvore de categorias do Cults (9 raízes + subcategorias). */
  async listCategories(): Promise<{ slug: string; name: string }[]> {
    if (!this.isConfigured()) throw new BadRequestException('Integração Cults3D não configurada.')
    const out = await this.gql<{ categories: Array<{ name: string; slug: string; children: Array<{ name: string; slug: string }> }> }>(
      `{ categories { name slug children { name slug } } }`, {})
    const flat: { slug: string; name: string }[] = []
    for (const c of out?.categories ?? []) {
      flat.push({ slug: c.slug, name: c.name })
      for (const ch of c.children ?? []) flat.push({ slug: ch.slug, name: `${c.name} › ${ch.name}` })
    }
    return flat
  }

  private normalize(slug: string, j: Record<string, any>): SourceModel {
    const priceCents = Number(j.price?.cents ?? 0)
    const isPaid = priceCents > 0
    const cover = j.illustrationImageUrl || j.illustrations?.[0]?.imageUrl || null
    const tags: string[] = Array.isArray(j.tags) ? j.tags.filter((t: unknown) => typeof t === 'string') : []
    const url = j.url || `https://cults3d.com/en/3d-model/${slug}`
    const lic = j.license ?? {}
    const licenseName: string | null = lic.name || lic.code || (isPaid ? 'Cults3D — pago' : 'Cults3D — grátis')

    // sinal comercial REAL do Cults (license.allowsCommercialUse). Derivado: não
    // há flag booleana, mas as licenças CC trazem "No derivatives" no nome/código
    // (ex BY-ND) → detecta pra não liberar remodelar o que é sem-derivados.
    const licText = `${lic.name ?? ''} ${lic.code ?? ''}`.toLowerCase()
    const noDeriv = /no[\s-]*derivativ|\bnd\b/.test(licText)
    const allowsCommercial = lic.allowsCommercialUse === true
    const allowsDerivative = !noDeriv

    return {
      platform:           'cults3d',
      source_url:         url,
      external_id:        slug,
      title:              String(j.name ?? '').trim(),
      license:            licenseName,
      license_title:      lic.code ? `Cults3D · ${lic.code}` : 'Cults3D',
      allow_recreation:   allowsDerivative,
      is_printable:       true,
      cover_url:          cover,
      creator:            j.creator?.nick || null,
      creator_handle:     j.creator?.nick || null,
      download_count:     Number(j.downloadsCount ?? 0),
      print_count:        0,
      like_count:         Number(j.likesCount ?? 0),
      collection_count:   Number(j.viewsCount ?? 0),
      tags,
      categories:         [],
      weight_g:           null,
      print_time_minutes: null,
      material_count:     null,
      need_ams:           false,
      is_remix:           false,
      price:              isPaid ? priceCents / 100 : null,
      verdict: buildVerdict({
        license: licenseName,
        allowsDerivative,
        allowsCommercial,
        commercialReason: `Licença "${licenseName}" do Cults3D não permite uso comercial — você pode imprimir/remodelar para uso próprio, mas para VENDER precisa adquirir a licença comercial do criador (depois libere no porteiro "Licença & origem").`,
        greenReason: `Licença "${licenseName}" do Cults3D permite uso comercial: pode imprimir, remodelar e vender.`,
      }),
      raw: {
        slug, name: j.name, url, shortUrl: j.shortUrl, price_cents: priceCents, currency: j.price?.currency,
        license: { code: lic.code, name: lic.name, allowsCommercialUse: lic.allowsCommercialUse, spdxId: lic.spdxId },
        downloadsCount: j.downloadsCount, likesCount: j.likesCount, viewsCount: j.viewsCount,
        creator: j.creator?.nick, publishedAt: j.publishedAt, tags, fetched_from: 'cults3d_graphql',
      },
    }
  }
}

// campos da Creation validados por introspection ao vivo (2026-06-25): planos,
// sem locale; creator{nick}; license{allowsCommercialUse}. Reusado por fetch/list/discover.
const CREATION_FIELDS = `
  name slug url shortUrl description
  illustrationImageUrl
  illustrations { imageUrl }
  price { cents currency }
  license { code name allowsCommercialUse availableOnFreeDesigns availableOnPricedDesigns spdxId }
  tags
  downloadsCount likesCount viewsCount
  publishedAt
  creator { nick }`
