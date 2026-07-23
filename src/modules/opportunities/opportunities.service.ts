import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MarketplaceScrapingService } from '../marketplace-scraping/marketplace-scraping.service'
import { OppHost, OppPain, OppReviewRow, PainStatus } from './opportunities.types'

const ML_API = 'https://api.mercadolibre.com'

/**
 * Radar de Encaixe — Peça 1: adotar o produto HOSPEDEIRO.
 *
 * Hospedeiro = produto de grande venda (air fryer, escova secadora…) pro
 * qual vamos descobrir um acessório 3D útil. As avaliações moram no ITEM
 * (anúncio MLB-N), não no produto de catálogo — spike 2026-07-23 confirmou:
 * /reviews/item/{item_id} com Bearer devolve texto completo + paginação;
 * /reviews/item/{catalog_id} devolve tudo zerado.
 */
@Injectable()
export class OpportunitiesService {
  private readonly logger = new Logger(OpportunitiesService.name)

  constructor(
    private readonly mercadolivre: MercadolivreService,
    private readonly scraping:     MarketplaceScrapingService,
  ) {}

  /** Token ML da org (refresh automático) com erro amigável. */
  async mlToken(orgId: string): Promise<string> {
    try {
      return (await this.mercadolivre.getTokenForOrg(orgId)).token
    } catch {
      throw new BadRequestException('Conecte sua conta Mercado Livre em Configurações > Integrações.')
    }
  }

  /** Extrai o id de anúncio (MLB-N) de uma URL ou id colado.
   *  Aceita: MLB1234567890, MLB-1234567890, URL de produto, URL com
   *  pdp_filters=item_id:MLBN. Catálogo puro (MLBU/MLBA/MLBB) → erro claro. */
  parseItemId(input: string): string {
    const raw = input.trim()
    // id colado direto
    const direct = raw.match(/^MLB-?(\d{6,})$/i)
    if (direct) return `MLB${direct[1]}`
    try {
      const u = new URL(raw)
      const pdp = u.searchParams.get('pdp_filters')
      if (pdp) {
        const m = pdp.match(/item_id[:=]MLB-?(\d{6,})/i)
        if (m) return `MLB${m[1]}`
      }
      if (/MLB[UAB]-?\d/i.test(u.pathname)) {
        throw new BadRequestException(
          'Essa URL é de um produto de CATÁLOGO (as avaliações ficam nos anúncios). Abra um anúncio específico (produto.mercadolivre.com.br/MLB-…) e cole essa URL.',
        )
      }
      const p = u.pathname.match(/MLB-?(\d{6,})/i)
      if (p) return `MLB${p[1]}`
    } catch (e) {
      if (e instanceof BadRequestException) throw e
      // não era URL — cai no erro genérico abaixo
    }
    throw new BadRequestException('Não achei um id de anúncio ML válido. Cole a URL do anúncio ou o id (MLB-1234567890).')
  }

  /** Adota um hospedeiro: resolve o anúncio, puxa dados + resumo de reviews. */
  async addHost(orgId: string, userId: string | null, input: { url: string; title?: string; notes?: string }): Promise<OppHost> {
    const itemId = this.parseItemId(input.url)
    const token  = await this.mlToken(orgId)

    // dados do anúncio via MarketplaceScrapingService (API com Bearer +
    // fallback HTML — /items de TERCEIRO dá 403 mesmo autenticado; se o
    // scrape falhar o host segue funcionando: reviews/mineração não dependem)
    let title: string | null = input.title?.trim() || null
    let thumbnail: string | null = null, permalink: string | null = null
    let priceCents: number | null = null
    const catalogId: string | null = null, categoryName: string | null = null, brand: string | null = null
    try {
      const s = await this.scraping.scrapeMlListing({ listingId: itemId, url: input.url.startsWith('http') ? input.url : undefined, orgId })
      title      = title ?? s.title
      thumbnail  = s.image_url
      permalink  = s.url
      priceCents = s.price != null ? Math.round(s.price * 100) : null
    } catch (e) {
      this.logger.warn(`[opp.host] scrape ${itemId} falhou: ${this.errMsg(e)} — sigo só com reviews`)
    }

    // resumo das avaliações (valida que o anúncio TEM reviews antes de adotar)
    const rv = await axios.get(`${ML_API}/reviews/item/${itemId}?limit=1`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 15_000,
    }).catch((e) => { throw new BadRequestException(`Não consegui ler as avaliações desse anúncio: ${this.errMsg(e)}`) })
    const paging = (rv.data as { paging?: { total?: number }; rating_average?: number; rating_levels?: Record<string, number> })

    const { data, error } = await supabaseAdmin.from('opp_host').upsert({
      organization_id: orgId,
      platform:        'mercado_livre',
      anchor_item_id:  itemId,
      item_ids:        [itemId],
      catalog_product_id: catalogId,
      title: title ?? undefined, brand, thumbnail,
      url:             permalink ?? `https://produto.mercadolivre.com.br/MLB-${itemId.slice(3)}`,
      price_cents:     priceCents,
      category_name:   categoryName,
      reviews_total:   paging.paging?.total ?? 0,
      rating_average:  paging.rating_average ?? null,
      rating_levels:   paging.rating_levels ?? null,
      status:          'ativo',
      notes:           input.notes ?? null,
      created_by:      userId,
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'organization_id,platform,anchor_item_id' }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao salvar hospedeiro: ${error?.message ?? 'sem dados'}`)
    return data as OppHost
  }

  async listHosts(orgId: string, status?: string): Promise<(OppHost & { pains_count: number; dores_count: number })[]> {
    let q = supabaseAdmin.from('opp_host').select('*').eq('organization_id', orgId).order('created_at', { ascending: false })
    if (status === 'ativo' || status === 'arquivado') q = q.eq('status', status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`opp_host: ${error.message}`)
    const hosts = (data ?? []) as OppHost[]
    if (hosts.length === 0) return []
    // contagem de dores por host (bulk, sem N+1)
    const { data: pains } = await supabaseAdmin
      .from('opp_pain').select('host_id,kind')
      .eq('organization_id', orgId)
      .in('host_id', hosts.map(h => h.id))
      .neq('status', 'descartada')
    const byHost = new Map<string, { p: number; d: number }>()
    for (const p of (pains ?? []) as { host_id: string; kind: string }[]) {
      const c = byHost.get(p.host_id) ?? { p: 0, d: 0 }
      c.p++; if (p.kind === 'dor') c.d++
      byHost.set(p.host_id, c)
    }
    return hosts.map(h => ({ ...h, pains_count: byHost.get(h.id)?.p ?? 0, dores_count: byHost.get(h.id)?.d ?? 0 }))
  }

  async getHost(orgId: string, hostId: string): Promise<OppHost> {
    const { data, error } = await supabaseAdmin.from('opp_host').select('*')
      .eq('organization_id', orgId).eq('id', hostId).maybeSingle()
    if (error) throw new BadRequestException(`opp_host: ${error.message}`)
    if (!data) throw new NotFoundException('Hospedeiro não encontrado')
    return data as OppHost
  }

  async archiveHost(orgId: string, hostId: string): Promise<void> {
    const { error } = await supabaseAdmin.from('opp_host')
      .update({ status: 'arquivado', updated_at: new Date().toISOString() })
      .eq('organization_id', orgId).eq('id', hostId)
    if (error) throw new BadRequestException(`opp_host: ${error.message}`)
  }

  async listPains(orgId: string, hostId: string): Promise<OppPain[]> {
    const { data, error } = await supabaseAdmin.from('opp_pain').select('*')
      .eq('organization_id', orgId).eq('host_id', hostId)
      .order('quote_count', { ascending: false })
    if (error) throw new BadRequestException(`opp_pain: ${error.message}`)
    return (data ?? []) as OppPain[]
  }

  async setPainStatus(orgId: string, painId: string, status: PainStatus): Promise<void> {
    const { error } = await supabaseAdmin.from('opp_pain')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId).eq('id', painId)
    if (error) throw new BadRequestException(`opp_pain: ${error.message}`)
  }

  async listReviews(orgId: string, hostId: string, maxStars?: number): Promise<OppReviewRow[]> {
    let q = supabaseAdmin.from('opp_review').select('*')
      .eq('organization_id', orgId).eq('host_id', hostId)
      .not('content', 'is', null)
      .order('rate', { ascending: true }).limit(300)
    if (maxStars != null) q = q.lte('rate', maxStars)
    const { data, error } = await q
    if (error) throw new BadRequestException(`opp_review: ${error.message}`)
    return (data ?? []) as OppReviewRow[]
  }

  errMsg(e: unknown): string {
    if (axios.isAxiosError(e)) return `HTTP ${e.response?.status ?? '?'} ${JSON.stringify(e.response?.data ?? {}).slice(0, 120)}`
    return e instanceof Error ? e.message : String(e)
  }
}
