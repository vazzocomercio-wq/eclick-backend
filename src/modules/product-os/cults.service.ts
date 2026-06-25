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
 * ⚠️ VALIDAR COM INTROSPECTION quando a chave existir (não testei ao vivo):
 *   1. a query `creation` aceita `id` (ID global base64 "Creation/123") — a URL
 *      do Cults traz só o SLUG, não o id. Resolvemos o slug via `creations`
 *      (busca) como best-effort; confirmar o nome do argumento/filtro.
 *   2. a semântica de licença comercial: paid model ≠ direito comercial
 *      automático. Default conservador aqui = amarelo (remodela, comercial
 *      exige a licença comercial do criador → liberar no porteiro). Refinar
 *      quando o campo de licença/uso comercial for confirmado na introspection.
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
    // ⚠️ VALIDAR: assume `creation(slug:)`. Se a introspection mostrar que só
    // existe `creation(id:)`, resolver o slug via `creations(filter:{...})` antes.
    const CREATION_FIELDS = `
      name(locale: EN)
      url(locale: EN)
      shortUrl
      description(locale: EN)
      illustrationImageUrl
      illustrations { imageUrl }
      price(currency: USD) { cents currency }
      tags(locale: EN)
      downloadsCount
      likesCount
      viewsCount(cached: true)
      publishedAt
      user { nick }`
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

  private normalize(slug: string, j: Record<string, any>): SourceModel {
    const priceCents = Number(j.price?.cents ?? 0)
    const isPaid = priceCents > 0
    const cover = j.illustrationImageUrl || j.illustrations?.[0]?.imageUrl || null
    const tags: string[] = Array.isArray(j.tags) ? j.tags.filter((t: unknown) => typeof t === 'string') : []
    const url = j.url || `https://cults3d.com/en/3d-model/${slug}`

    // ⚠️ VALIDAR: licença comercial do Cults precisa de campo confirmado. Default
    // conservador: pode remodelar; comercial exige a licença comercial do criador
    // (o lojista libera no porteiro depois de adquiri-la). Modelo grátis tende a
    // ser uso pessoal/atribuição → também não-comercial por padrão.
    const allowsDerivative = true
    const allowsCommercial = false

    return {
      platform:           'cults3d',
      source_url:         url,
      external_id:        slug,
      title:              String(j.name ?? '').trim(),
      license:            isPaid ? 'Cults3D — pago' : 'Cults3D — grátis',
      license_title:      'Cults3D (licença comercial vendida pelo criador)',
      allow_recreation:   allowsDerivative,
      is_printable:       true,
      cover_url:          cover,
      creator:            j.user?.nick || null,
      creator_handle:     j.user?.nick || null,
      download_count:     Number(j.downloadsCount ?? 0),
      print_count:        0,
      like_count:         Number(j.likesCount ?? 0),
      collection_count:   0,
      tags,
      categories:         [],
      weight_g:           null,
      print_time_minutes: null,
      material_count:     null,
      need_ams:           false,
      is_remix:           false,
      price:              isPaid ? priceCents / 100 : null,
      verdict: buildVerdict({
        license: isPaid ? 'modelo pago Cults3D' : 'modelo grátis Cults3D',
        allowsDerivative,
        allowsCommercial,
        commercialReason: 'Cults3D vende licença comercial por modelo: você pode remodelar, mas para VENDER precisa adquirir a licença comercial do criador. Depois de comprá-la, libere no porteiro ("Licença & origem").',
      }),
      raw: {
        slug, name: j.name, url, shortUrl: j.shortUrl, price_cents: priceCents, currency: j.price?.currency,
        downloadsCount: j.downloadsCount, likesCount: j.likesCount, viewsCount: j.viewsCount,
        user: j.user?.nick, publishedAt: j.publishedAt, tags, fetched_from: 'cults3d_graphql',
      },
    }
  }
}
