import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MercadolivreService } from '../../../mercadolivre/mercadolivre.service'
import { MarketplacePlatform, ScrapedListing } from '../../shared/types'
import { GeoSkipError } from '../../shared/skip-error'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
}

/**
 * Extrai dados estruturados de um listing pra alimentar o GEO Score.
 *
 * ML: usa o token da org (MercadolivreService.getTokenForOrg) — anônimo é
 * bloqueado pelo PolicyAgent até pra anúncios próprios. Busca /items/{id}
 * (título, preço, atributos, categoria, fotos) + /items/{id}/description
 * (texto) + reviews best-effort. Generic: cheerio (title/meta/JSON-LD).
 * Shopee: API v4. Amazon: fallback generic (bloqueio pesado).
 */
@Injectable()
export class ListingScraperService {
  private readonly logger = new Logger(ListingScraperService.name)

  constructor(private readonly mercadolivre: MercadolivreService) {}

  detectPlatform(url: string): MarketplacePlatform {
    const u = url.toLowerCase()
    if (/mercadoli(vre|bre)/.test(u)) return 'mercadolivre'
    if (/shopee/.test(u))            return 'shopee'
    if (/amazon\./.test(u))          return 'amazon'
    return 'generic'
  }

  async scrape(url: string, orgId: string): Promise<ScrapedListing> {
    const platform = this.detectPlatform(url)
    switch (platform) {
      case 'mercadolivre': return this.scrapeMl(url, orgId)
      case 'shopee':       return this.scrapeShopee(url)
      default:             return this.scrapeGeneric(url, platform)
    }
  }

  // ── Mercado Livre (autenticado) ───────────────────────────────────────────

  private async scrapeMl(url: string, orgId: string): Promise<ScrapedListing> {
    const id = this.extractMlId(url)
    // Sem id de produto = link de loja/categoria/busca, não de um anúncio.
    // Skip determinístico (não é falha, não retenta) — a UI orienta a colar o link do produto.
    if (!id) throw new GeoSkipError('not_a_product', `URL ML sem id de produto (MLB): ${url}`)

    // Multi-conta: a org pode ter várias contas ML e o anúncio pode ser de
    // qualquer uma. getTokenForOrg pega só 1 conta (a mais recente) → ler item
    // de OUTRA conta dá 403. Por isso tentamos /items/{id} com o token de CADA
    // conta da org até um retornar 200 (conta dona do anúncio).
    let tokens: Array<{ token: string; sellerId: number }>
    try {
      tokens = await this.mercadolivre.getAllTokensForOrg(orgId)
    } catch (e) {
      this.logger.warn(`[geo-scrape] getAllTokensForOrg(${orgId}) falhou: ${(e as Error).message}`)
      throw new BadRequestException('Conecte sua conta Mercado Livre em Configurações > Integrações.')
    }

    let item: Record<string, unknown> | null = null
    let headers: Record<string, string> = { ...HEADERS, Accept: 'application/json' }
    let lastStatus: number | undefined
    for (const { token } of tokens) {
      const h = { ...HEADERS, Accept: 'application/json', Authorization: `Bearer ${token}` }
      try {
        const { data } = await axios.get(`https://api.mercadolibre.com/items/${id}`, { headers: h, timeout: 15_000 })
        item = data as Record<string, unknown>
        headers = h
        break
      } catch (e) {
        lastStatus = (e as { response?: { status?: number } }).response?.status
        // 401/403/404 → tenta a próxima conta (anúncio pode ser de outra)
      }
    }
    if (!item) {
      // Determinísticos → pular (sem retry).
      if (lastStatus === 403) throw new GeoSkipError('blocked_by_marketplace', `ML 403 em ${id}`)
      if (lastStatus === 404) throw new GeoSkipError('product_not_found', `ML 404 em ${id}`)
      // 401 = token realmente inválido em todas as contas (config) → erro real, retry.
      if (lastStatus === 401) {
        throw new BadRequestException('Token Mercado Livre inválido/expirado em todas as contas. Reconecte em Configurações > Integrações.')
      }
      throw new BadRequestException(`Anúncio ${id} não retornou dados (status ${lastStatus ?? '?'}).`)
    }

    // Anúncio indisponível (esgotado/pausado/finalizado) → pular (sem retry).
    const mlStatus = String(item.status ?? '')
    const availQty = Number(item.available_quantity ?? -1)
    if (mlStatus === 'paused' || mlStatus === 'closed' || availQty === 0) {
      throw new GeoSkipError('product_unavailable', `ML status=${mlStatus} qty=${availQty}`)
    }

    const attrsRaw = Array.isArray(item.attributes) ? item.attributes as Array<Record<string, unknown>> : []
    const attributes = attrsRaw
      .map(a => ({ name: String(a.name ?? ''), value: String(a.value_name ?? '') }))
      .filter(a => a.name && a.value)

    const pictures = Array.isArray(item.pictures) ? item.pictures as Array<{ url?: string; secure_url?: string }> : []
    const images = pictures.map(p => p.secure_url || p.url || '').filter(Boolean).slice(0, 12)

    const [description, reviews, category] = await Promise.all([
      this.mlDescription(id, headers),
      this.mlReviews(id, headers),
      this.mlCategory(String(item.category_id ?? ''), headers),
    ])

    const title = (item.title as string) ?? null
    if (!title) throw new BadRequestException('Anúncio sem título — pode estar removido.')

    return {
      url,
      platform:      'mercadolivre',
      listingId:     id,
      title,
      description,
      attributes,
      price:         Number(item.price ?? 0) || null,
      images,
      reviews_count: reviews.count,
      rating:        reviews.rating,
      category,
    }
  }

  private async mlDescription(id: string, headers: Record<string, string>): Promise<string | null> {
    try {
      const { data } = await axios.get(`https://api.mercadolibre.com/items/${id}/description`, { headers, timeout: 10_000 })
      const txt = (data?.plain_text || data?.text || '') as string
      return txt.trim() || null
    } catch { return null }
  }

  private async mlReviews(id: string, headers: Record<string, string>): Promise<{ count: number | null; rating: number | null }> {
    try {
      const { data } = await axios.get(`https://api.mercadolibre.com/reviews/item/${id}`, { headers, timeout: 10_000 })
      const count = Number(data?.paging?.total ?? data?.rating_levels?.total ?? 0) || null
      const rating = Number(data?.rating_average ?? 0) || null
      return { count, rating }
    } catch { return { count: null, rating: null } }
  }

  private async mlCategory(categoryId: string, headers: Record<string, string>): Promise<string | null> {
    if (!categoryId) return null
    try {
      const { data } = await axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, { headers, timeout: 10_000 })
      return (data?.name as string) ?? null
    } catch { return null }
  }

  private extractMlId(url: string): string | null {
    // Anúncio (MLB-N), ignorando catálogo (MLBU/MLBA/MLBB).
    const m = url.match(/MLB-?(\d{6,})(?![\w])/i)
    if (m && !/MLB[UAB]/i.test(m[0])) return `MLB${m[1]}`
    const pdp = url.match(/item_id[:=]MLB-?(\d{6,})/i)
    if (pdp) return `MLB${pdp[1]}`
    return null
  }

  // ── Shopee (API v4) ───────────────────────────────────────────────────────

  private async scrapeShopee(url: string): Promise<ScrapedListing> {
    const m = url.match(/i\.(\d+)\.(\d+)/)
    if (!m) throw new BadRequestException('URL Shopee inválida — esperado i.SHOP.ITEM.')
    const [shopId, itemId] = [m[1], m[2]]
    try {
      const { data: res } = await axios.get(
        `https://shopee.com.br/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
        { headers: { ...HEADERS, Referer: 'https://shopee.com.br/', 'X-Requested-With': 'XMLHttpRequest' }, timeout: 15_000 },
      )
      const item = res?.data?.item
      if (!item) throw new GeoSkipError('product_not_found', `Shopee item null ${shopId}.${itemId}`)
      const imageHashes = Array.isArray(item.images) ? item.images as string[] : []
      return {
        url,
        platform:      'shopee',
        listingId:     `${shopId}.${itemId}`,
        title:         item.name ?? null,
        description:   (item.description as string)?.trim() || null,
        attributes:    Array.isArray(item.attributes)
          ? (item.attributes as Array<{ name?: string; value?: string }>)
              .map(a => ({ name: String(a.name ?? ''), value: String(a.value ?? '') })).filter(a => a.name && a.value)
          : [],
        price:         item.price ? item.price / 100_000 : null,
        images:        imageHashes.map(h => `https://cf.shopee.com.br/file/${h}`).slice(0, 12),
        reviews_count: Number(item.cmt_count ?? 0) || null,
        rating:        Number(item.item_rating?.rating_star ?? 0) || null,
        category:      null,
      }
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof GeoSkipError) throw e
      const st = (e as { response?: { status?: number } }).response?.status
      if (st === 403) throw new GeoSkipError('blocked_by_marketplace', `Shopee 403 ${shopId}.${itemId}`)
      if (st === 404) throw new GeoSkipError('product_not_found', `Shopee 404 ${shopId}.${itemId}`)
      throw new BadRequestException('Shopee bloqueou a leitura do item (anti-bot). Tente novamente mais tarde.')
    }
  }

  // ── Generic / Amazon (cheerio sobre HTML estático) ─────────────────────────

  private async scrapeGeneric(url: string, platform: MarketplacePlatform): Promise<ScrapedListing> {
    let html: string
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20_000, maxContentLength: 5_000_000 })
      html = res.data as string
    } catch (e) {
      const st = (e as { response?: { status?: number } }).response?.status
      if (st === 403) throw new GeoSkipError('blocked_by_marketplace', `403 em ${url}`)
      if (st === 404) throw new GeoSkipError('product_not_found', `404 em ${url}`)
      throw new BadRequestException('Não consegui carregar a página (timeout ou bloqueio).')
    }
    const $ = cheerio.load(html)

    let title = $('meta[property="og:title"]').attr('content')
      || $('h1').first().text().trim()
      || $('title').text().trim()
      || null
    const metaDesc = $('meta[property="og:description"]').attr('content')
      || $('meta[name="description"]').attr('content')
      || null
    const attributes: Array<{ name: string; value: string }> = []
    let price: number | null = null
    let category: string | null = null
    let reviews_count: number | null = null
    let rating: number | null = null
    let jsonLdDesc: string | null = null
    let faqText = ''
    const images: string[] = []

    // JSON-LD: lê TODOS os blocos (inclui @graph) — Product/Offer/AggregateRating/
    // FAQPage/BreadcrumbList. É o que torna o GEO Score capaz de "ver" páginas
    // de site próprio tão bem quanto um anúncio de marketplace.
    const nodes: Array<Record<string, unknown>> = []
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '')
        const graph = (json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>)['@graph']))
          ? (json as Record<string, unknown>)['@graph'] as unknown[]
          : (Array.isArray(json) ? json : [json])
        for (const n of graph) if (n && typeof n === 'object') nodes.push(n as Record<string, unknown>)
      } catch { /* ignore bloco inválido */ }
    })
    const typesOf = (n: Record<string, unknown>): string[] => {
      const t = n['@type']
      return (Array.isArray(t) ? t : [t]).map(x => String(x ?? ''))
    }
    const product   = nodes.find(n => typesOf(n).some(t => /product/i.test(t)))
    const faqPage   = nodes.find(n => typesOf(n).some(t => /faqpage/i.test(t)))
    const breadcrumb = nodes.find(n => typesOf(n).some(t => /breadcrumblist/i.test(t)))

    if (product) {
      const p = product as Record<string, any>
      if (!title && p.name) title = String(p.name)
      if (p.description) jsonLdDesc = String(p.description)
      if (p.brand) attributes.push({ name: 'Marca', value: String(p.brand?.name ?? p.brand) })
      if (p.sku) attributes.push({ name: 'SKU', value: String(p.sku) })
      if (p.gtin13 ?? p.gtin) attributes.push({ name: 'GTIN', value: String(p.gtin13 ?? p.gtin) })
      if (p.category) category = String(p.category)
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers
      if (offer?.price) price = parseFloat(String(offer.price))
      if (offer?.availability) attributes.push({ name: 'Disponibilidade', value: String(offer.availability).replace(/.*\//, '') })
      if (offer?.itemCondition) attributes.push({ name: 'Condição', value: String(offer.itemCondition).replace(/.*\//, '') })
      const agg = p.aggregateRating
      if (agg) {
        rating = Number(agg.ratingValue) || null
        reviews_count = Number(agg.reviewCount ?? agg.ratingCount) || null
      }
      if (p.image) {
        const imgs = Array.isArray(p.image) ? p.image : [p.image]
        imgs.forEach((u: unknown) => { if (typeof u === 'string') images.push(u) })
      }
    }

    // FAQPage → texto de FAQ (alimenta a dimensão faq_presence).
    if (faqPage) {
      const ents = (faqPage as Record<string, any>).mainEntity
      const arr = Array.isArray(ents) ? ents : (ents ? [ents] : [])
      const qas = arr.map((q: any) => {
        const ans = q?.acceptedAnswer?.text ?? q?.acceptedAnswer ?? ''
        return q?.name ? `P: ${String(q.name)}\nR: ${typeof ans === 'string' ? ans : String(ans?.text ?? '')}` : ''
      }).filter(Boolean)
      if (qas.length) faqText = `Perguntas frequentes:\n${qas.join('\n')}`
    }

    // BreadcrumbList → categoria (penúltimo item).
    if (!category && breadcrumb) {
      const els = (breadcrumb as Record<string, any>).itemListElement
      const arr = Array.isArray(els) ? els : []
      const names = arr.map((e: any) => e?.name).filter(Boolean).map(String)
      if (names.length >= 2) category = names[names.length - 2]
    }

    if (!title) throw new BadRequestException('Página sem título reconhecível — não parece um produto.')

    // Texto visível da página (sem scripts/estilos/chrome) — complementa quando o
    // JSON-LD é raso, pra refletir o que uma IA leria de fato na página.
    $('script, style, noscript, svg, nav, footer, header').remove()
    const bodyText = (($('main').text() || $('body').text() || '').replace(/\s+/g, ' ').trim())

    // Descrição composta: estruturado primeiro (Product + FAQ), depois texto visível.
    const parts = [jsonLdDesc, metaDesc, faqText].filter(Boolean) as string[]
    let description = parts.join('\n\n').trim()
    if (description.length < 800 && bodyText) description = `${description}\n\n${bodyText}`.trim()
    description = description.slice(0, 6000)

    return {
      url,
      platform,
      listingId:     null,
      title,
      description:   description || null,
      attributes,
      price,
      images:        [...new Set(images)].slice(0, 12),
      reviews_count,
      rating,
      category,
      rawHtmlSnippet: html.slice(0, 2000),
    }
  }
}
