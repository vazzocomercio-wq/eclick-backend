import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { type ModelSourceProvider, type SourceModel, buildVerdict } from './model-sources/source.types'

/**
 * Thingiverse (MakerBot) — provedor via API REST OFICIAL.
 *
 * Diferente do MakerWorld, é API pública documentada: precisa de um app token
 * (Bearer) que o lojista gera de graça em thingiverse.com/developers. Fica em
 * `THINGIVERSE_TOKEN` (token global do app, não por usuário). Dormente até a env.
 *
 * Licença vem como STRING legível ("Creative Commons - Attribution - Non-
 * Commercial" etc) → mapeamos pra derivar?/vender? e o veredito sai igual ao
 * das outras fontes. SEM peso/tempo de impressão (Thingiverse não expõe slicer).
 */

const BASE = 'https://api.thingiverse.com'

@Injectable()
export class ThingiverseService implements ModelSourceProvider {
  readonly platform = 'thingiverse'
  readonly label = 'Thingiverse'
  private readonly logger = new Logger(ThingiverseService.name)

  private token(): string | null { return process.env.THINGIVERSE_TOKEN?.trim() || null }
  isConfigured(): boolean { return !!this.token() }

  matchUrl(input: string): boolean { return /thingiverse\.com/i.test(input ?? '') }

  parseId(input: string): string {
    const raw = (input ?? '').trim()
    if (!raw) throw new BadRequestException('Informe o link ou o ID do modelo Thingiverse.')
    if (/^\d{2,}$/.test(raw)) return raw
    const m = raw.match(/thing:(\d+)/i)              // .../thing:1234567
    if (m) return m[1]
    const m2 = raw.match(/things\/(\d+)/i)           // api .../things/1234567
    if (m2) return m2[1]
    throw new BadRequestException('Link Thingiverse inválido. Cole a URL do modelo (ex: thingiverse.com/thing:1234567) ou o ID.')
  }

  async fetchModel(input: string): Promise<SourceModel> {
    const token = this.token()
    if (!token) throw new BadRequestException('Integração Thingiverse não configurada (defina THINGIVERSE_TOKEN).')
    const id = this.parseId(input)
    try {
      const { data } = await axios.get(`${BASE}/things/${id}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 12000,
        validateStatus: s => s === 200,
      })
      if (!data || !data.id) throw new NotFoundException('Modelo não encontrado no Thingiverse.')
      return this.normalize(id, data as Record<string, any>)
    } catch (e) {
      if (e instanceof NotFoundException) throw e
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 404) throw new NotFoundException('Modelo não encontrado, removido ou privado no Thingiverse.')
      if (status === 401 || status === 403) throw new BadRequestException('Token do Thingiverse inválido ou sem permissão. Revise THINGIVERSE_TOKEN.')
      this.logger.warn(`[thingiverse] falha ao buscar thing ${id}: ${(e as Error).message}`)
      throw new BadRequestException('Não consegui ler o Thingiverse agora. Tente de novo em instantes.')
    }
  }

  /** Modelos de um criador, mais curtidos primeiro. O resumo de /users/{nick}/
   *  things NÃO traz licença/downloads → busca o detalhe dos top-N (paralelo). */
  async listByCreator(handle: string, limit = 12): Promise<SourceModel[]> {
    const token = this.token()
    if (!token) throw new BadRequestException('Integração Thingiverse não configurada (defina THINGIVERSE_TOKEN).')
    const nick = (handle ?? '').replace(/^@/, '').trim()
    if (!nick) throw new BadRequestException('Informe o nick do criador no Thingiverse.')
    const n = Math.min(20, Math.max(1, limit))
    let summaries: Array<Record<string, any>> = []
    try {
      const { data } = await axios.get(`${BASE}/users/${encodeURIComponent(nick)}/things?per_page=30`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 12000, validateStatus: s => s === 200,
      })
      summaries = Array.isArray(data) ? data : (data?.hits ?? [])
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status
      if (status === 404) throw new NotFoundException('Criador não encontrado no Thingiverse.')
      throw new BadRequestException('Não consegui listar os modelos desse criador no Thingiverse.')
    }
    const top = summaries
      .filter(t => t?.id && t.is_published !== 0)
      .sort((a, b) => Number(b.like_count ?? 0) - Number(a.like_count ?? 0))
      .slice(0, n)
    const models = await Promise.all(top.map(t => this.fetchModel(String(t.id)).catch(() => null)))
    return models.filter((m): m is SourceModel => m != null)
  }

  /** Busca por palavra-chave. Resumo sem licença → busca detalhe dos top-N. */
  async search(query: string, opts: { commercialOnly?: boolean; limit?: number } = {}): Promise<SourceModel[]> {
    const token = this.token()
    if (!token) throw new BadRequestException('Integração Thingiverse não configurada.')
    const q = (query ?? '').trim()
    if (!q) throw new BadRequestException('Informe o termo de busca.')
    const n = Math.min(20, Math.max(1, opts.limit ?? 12))
    let hits: Array<Record<string, any>> = []
    try {
      const { data } = await axios.get(`${BASE}/search/${encodeURIComponent(q)}?per_page=30`, { headers: { Authorization: `Bearer ${token}` }, timeout: 12000, validateStatus: s => s === 200 })
      hits = Array.isArray(data) ? data : (data?.hits ?? [])
    } catch { throw new BadRequestException('Não consegui buscar no Thingiverse.') }
    const top = hits.filter(t => t?.id && t.is_published !== 0).slice(0, n)
    const models = (await Promise.all(top.map(t => this.fetchModel(String(t.id)).catch(() => null)))).filter((m): m is SourceModel => m != null)
    return opts.commercialOnly ? models.filter(m => m.verdict.can_commercial) : models
  }

  /** Categorias do Thingiverse (amplas: Household, Art, Gadgets…). */
  async listCategories(): Promise<{ slug: string; name: string }[]> {
    const token = this.token()
    if (!token) throw new BadRequestException('Integração Thingiverse não configurada.')
    const { data } = await axios.get(`${BASE}/categories`, { headers: { Authorization: `Bearer ${token}` }, timeout: 12000, validateStatus: s => s === 200 })
    const arr = Array.isArray(data) ? data : (data?.categories ?? [])
    return arr.map((c: any) => ({ slug: c.slug || (c.url ?? '').split('/').filter(Boolean).pop(), name: c.name })).filter((c: any) => c.slug && c.name)
  }

  /** Feed por categoria (ou populares). Resumo sem licença → busca detalhe top-N. */
  async discover(opts: { categorySlug?: string; commercialOnly?: boolean; limit?: number } = {}): Promise<SourceModel[]> {
    const token = this.token()
    if (!token) throw new BadRequestException('Integração Thingiverse não configurada.')
    const n = Math.min(20, Math.max(1, opts.limit ?? 12))
    const url = opts.categorySlug
      ? `${BASE}/categories/${encodeURIComponent(opts.categorySlug)}/things?per_page=30`
      : `${BASE}/popular?per_page=30`
    let summaries: Array<Record<string, any>> = []
    try {
      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 12000, validateStatus: s => s === 200 })
      summaries = Array.isArray(data) ? data : (data?.hits ?? [])
    } catch { throw new BadRequestException('Não consegui carregar os modelos do Thingiverse.') }
    const top = summaries.filter(t => t?.id && t.is_published !== 0).slice(0, n)
    const models = (await Promise.all(top.map(t => this.fetchModel(String(t.id)).catch(() => null)))).filter((m): m is SourceModel => m != null)
    return opts.commercialOnly ? models.filter(m => m.verdict.can_commercial) : models
  }

  private normalize(id: string, j: Record<string, any>): SourceModel {
    const license: string | null = j.license || null
    const s = (license ?? '').toLowerCase()
    const noDeriv  = /no\s*derivativ/.test(s)
    const nonComm  = /non[\s-]*commercial/.test(s)
    const allRights = /all rights reserved/.test(s)
    const unknown  = !license
    const allowsDerivative = !unknown && !noDeriv && !allRights
    const allowsCommercial = !unknown && !nonComm && !allRights
    const cover = j.default_image?.url || j.default_image?.sizes?.find?.((x: any) => x.type === 'display')?.url || j.thumbnail || null
    const tags: string[] = Array.isArray(j.tags) ? j.tags.map((t: any) => (typeof t === 'string' ? t : t?.name)).filter(Boolean) : []

    return {
      platform:           'thingiverse',
      source_url:         j.public_url || `https://www.thingiverse.com/thing:${id}`,
      external_id:        String(j.id ?? id),
      title:              String(j.name ?? '').trim(),
      license,
      license_title:      license,
      allow_recreation:   allowsDerivative,
      is_printable:       true,
      cover_url:          cover,
      creator:            j.creator?.name || j.creator?.first_name || null,
      creator_handle:     j.creator?.name || null,
      download_count:     Number(j.download_count ?? 0),
      print_count:        Number(j.made_count ?? 0),
      like_count:         Number(j.like_count ?? 0),
      collection_count:   Number(j.collect_count ?? 0),
      tags,
      categories:         [],
      weight_g:           null,
      print_time_minutes: null,
      material_count:     null,
      need_ams:           false,
      is_remix:           false,
      price:              null,
      verdict: buildVerdict({
        license,
        allowsDerivative,
        allowsCommercial,
        restrictiveReason: unknown
          ? 'O modelo não informa licença — trate como "todos os direitos reservados" até confirmar com o criador.'
          : noDeriv
            ? `Licença "${license}" é "sem derivados": não pode remodelar.`
            : `Licença "${license}" reserva os direitos: não permite criar obra derivada.`,
        commercialReason: `Licença "${license}" permite derivar, porém é não comercial — vender exige autorização do criador.`,
        greenReason: `Licença "${license}" permite criar obra derivada e uso comercial.`,
      }),
      raw: {
        id: j.id, name: j.name, license, public_url: j.public_url, creator: j.creator?.name,
        like_count: j.like_count, collect_count: j.collect_count, download_count: j.download_count, made_count: j.made_count,
        is_published: j.is_published, added: j.added, tags, fetched_from: 'thingiverse_things',
      },
    }
  }
}
