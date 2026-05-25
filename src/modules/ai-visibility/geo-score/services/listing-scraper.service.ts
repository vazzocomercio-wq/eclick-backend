import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { MercadolivreService } from '../../../mercadolivre/mercadolivre.service'
import { MarketplacePlatform, ScrapedListing } from '../../shared/types'

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
    if (!id) throw new BadRequestException('URL ML inválida — esperado MLB-1234567.')

    let token: string
    try {
      token = (await this.mercadolivre.getTokenForOrg(orgId)).token
    } catch (e) {
      this.logger.warn(`[geo-scrape] getTokenForOrg(${orgId}) falhou: ${(e as Error).message}`)
      throw new BadRequestException('Conecte sua conta Mercado Livre em Configurações > Integrações.')
    }
    const headers = { ...HEADERS, Accept: 'application/json', Authorization: `Bearer ${token}` }

    let item: Record<string, unknown>
    try {
      const { data } = await axios.get(`https://api.mercadolibre.com/items/${id}`, { headers, timeout: 15_000 })
      item = data as Record<string, unknown>
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status
      if (status === 401 || status === 403) {
        throw new BadRequestException('Token Mercado Livre inválido/expirado. Reconecte em Configurações > Integrações.')
      }
      throw new BadRequestException(`Anúncio ${id} não retornou dados (status ${status ?? '?'}) — pode estar pausado ou removido.`)
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
      if (!item) throw new BadRequestException('Item Shopee não encontrado.')
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
      if (e instanceof BadRequestException) throw e
      throw new BadRequestException('Shopee bloqueou a leitura do item (anti-bot). Tente novamente mais tarde.')
    }
  }

  // ── Generic / Amazon (cheerio sobre HTML estático) ─────────────────────────

  private async scrapeGeneric(url: string, platform: MarketplacePlatform): Promise<ScrapedListing> {
    let html: string
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20_000, maxContentLength: 5_000_000 })
      html = res.data as string
    } catch {
      throw new BadRequestException('Não consegui carregar a página (timeout ou bloqueio).')
    }
    const $ = cheerio.load(html)

    let title = $('meta[property="og:title"]').attr('content')
      || $('h1').first().text().trim()
      || $('title').text().trim()
      || null
    let description = $('meta[property="og:description"]').attr('content')
      || $('meta[name="description"]').attr('content')
      || null
    const attributes: Array<{ name: string; value: string }> = []
    let price: number | null = null
    const images: string[] = []

    // JSON-LD (schema.org Product) — fonte mais rica quando existe.
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '')
        const node = Array.isArray(json) ? json.find(j => /product/i.test(j?.['@type'] ?? '')) : json
        if (!node) return
        if (!title && node.name) title = String(node.name)
        if (!description && node.description) description = String(node.description)
        if (node.offers?.price) price = parseFloat(node.offers.price)
        if (node.brand) attributes.push({ name: 'Marca', value: String(node.brand?.name ?? node.brand) })
        if (node.image) {
          const imgs = Array.isArray(node.image) ? node.image : [node.image]
          imgs.forEach((u: unknown) => { if (typeof u === 'string') images.push(u) })
        }
      } catch { /* ignore */ }
    })

    if (!title) throw new BadRequestException('Página sem título reconhecível — não parece um produto.')

    return {
      url,
      platform,
      listingId:     null,
      title,
      description:   description?.trim() || null,
      attributes,
      price,
      images:        [...new Set(images)].slice(0, 12),
      reviews_count: null,
      rating:        null,
      category:      null,
      rawHtmlSnippet: html.slice(0, 2000),
    }
  }
}
