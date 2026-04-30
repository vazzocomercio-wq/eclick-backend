import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'
import { ScraperService } from '../scraper/scraper.service'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
}

export interface ListingSummary {
  title:        string | null
  price:        number | null
  sale_price:   number | null   // promo price quando disponível
  image_url:    string | null   // primeira/principal
  all_images:   string[]        // galeria completa (até 12)
  url:          string | null
  platform:     string
  listing_id:   string | null
}

/** Sprint F5-2 — service consolidado pra scraping de marketplaces +
 * busca de galeria de imagens. Delega ao ScraperService legacy quando
 * possível (modo de transição — não toca CompetitorsService) e
 * adiciona métodos novos pra galeria de imagens (campaigns wizard).
 *
 * Reuso futuro: CompetitorsService pode migrar pra cá em sprint
 * separada quando seguros (zero risco em produção agora). */
@Injectable()
export class MarketplaceScrapingService {
  private readonly logger = new Logger(MarketplaceScrapingService.name)

  constructor(private readonly scraper: ScraperService) {}

  // ── ML ──────────────────────────────────────────────────────────────────

  /** Busca dados completos de um anúncio ML (preço, promo, todas as imagens).
   * Usa API pública /items/{id} primeiro; se 403/404 cai no scraper legacy. */
  async scrapeMlListing(input: { url?: string; listingId?: string }): Promise<ListingSummary> {
    const id = input.listingId ?? this.extractMlbId(input.url ?? '')
    if (!id) throw new BadRequestException('URL ou listingId ML obrigatório')

    try {
      const { data } = await axios.get(
        `https://api.mercadolibre.com/items/${id}`,
        { headers: HEADERS, timeout: 10_000 },
      )
      const pictures = Array.isArray(data.pictures) ? data.pictures as Array<{ url?: string; secure_url?: string }> : []
      const allImages = pictures
        .map(p => p.secure_url || p.url || '')
        .filter(u => !!u)
        .slice(0, 12)

      // Promo detection: original_price + price (price atual = preço com promo)
      const price = Number(data.price ?? 0) || null
      const original = Number(data.original_price ?? 0) || null
      const salePrice = original && price && original > price ? price : null
      const basePrice = original ?? price

      return {
        title:      (data.title as string) ?? null,
        price:      basePrice,
        sale_price: salePrice,
        image_url:  allImages[0] ?? (data.thumbnail as string) ?? null,
        all_images: allImages,
        url:        (data.permalink as string) ?? input.url ?? null,
        platform:   'mercadolivre',
        listing_id: id,
      }
    } catch (e) {
      this.logger.warn(`[ml.scrape] API ${id} falhou (${(e as Error).message}) — fallback HTML`)
    }

    // Fallback HTML scrape
    if (input.url) {
      return this.scrapeMlHtml(input.url, id)
    }
    throw new BadRequestException(`Não foi possível buscar listing ${id}`)
  }

  private async scrapeMlHtml(url: string, id: string): Promise<ListingSummary> {
    const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15_000 })
    const $ = cheerio.load(html)

    let price: number | null = null
    let title: string | null = null
    const images: string[] = []

    $("script[type='application/ld+json']").each((_i, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '')
        if (json?.offers?.price) price = parseFloat(json.offers.price)
        if (json?.name) title = json.name
        if (json?.image) {
          const imgs = Array.isArray(json.image) ? json.image : [json.image]
          for (const u of imgs) if (typeof u === 'string') images.push(u)
        }
      } catch { /* ignore */ }
    })

    if (!price) {
      const frac = $(".andes-money-amount__fraction").first().text().replace(/\./g, '')
      if (frac) price = parseFloat(frac)
    }
    if (!title) title = $("h1.ui-pdp-title").text().trim() || null

    // Galeria via figure.ui-pdp-gallery__figure img
    $("figure.ui-pdp-gallery__figure img").each((_i, el) => {
      const src = $(el).attr('data-zoom') || $(el).attr('src')
      if (src) images.push(src)
    })

    return {
      title,
      price,
      sale_price: null,  // HTML não distingue confiavelmente
      image_url:  images[0] ?? null,
      all_images: [...new Set(images)].slice(0, 12),
      url,
      platform:   'mercadolivre',
      listing_id: id,
    }
  }

  /** Extrai ID canonical do anúncio ML a partir de URL ou raw ID.
   *
   * Casos cobertos:
   *   MLB-4422969927       → MLB4422969927    ✓ (URL canonical com hífen)
   *   MLB4422969927        → MLB4422969927    ✓ (formato API)
   *   MLBU-3274907         → MLBU3274907      ✓ (catalog product)
   *   mlb1234567           → MLB1234567       ✓ (case-insensitive)
   *   /algo-aleatorio      → null             ✓ (não match)
   *
   * Não cobre (deliberado nesta sprint):
   *   MLA-9999 (Argentina), MLM (México), etc — Vazzo opera só BR. */
  private extractMlbId(url: string): string | null {
    const m = url.match(/(MLB[UAB]?)-?(\d{6,})/i)
    if (!m) return null
    return (m[1] + m[2]).toUpperCase()
  }

  // ── Shopee ──────────────────────────────────────────────────────────────

  async scrapeShopeeListing(input: { url?: string; shopId?: string; itemId?: string }): Promise<ListingSummary> {
    let shopId = input.shopId
    let itemId = input.itemId
    if ((!shopId || !itemId) && input.url) {
      const m = input.url.match(/i\.(\d+)\.(\d+)/)
      if (m) { shopId = m[1]; itemId = m[2] }
    }
    if (!shopId || !itemId) throw new BadRequestException('shopId+itemId ou URL Shopee obrigatórios')

    const { data: res } = await axios.get(
      `https://shopee.com.br/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
      {
        headers: { ...HEADERS, 'Referer': 'https://shopee.com.br/', 'X-Requested-With': 'XMLHttpRequest' },
        timeout: 15_000,
      },
    )
    const item = res?.data?.item
    if (!item) throw new BadRequestException('Item não encontrado na Shopee')

    const imageHashes = Array.isArray(item.images) ? item.images as string[] : []
    const allImages = imageHashes.map(h => `https://cf.shopee.com.br/file/${h}`).slice(0, 12)

    const priceCents = item.price_min ?? item.price ?? null
    const beforeCents = item.price_before_discount ?? null
    const price      = beforeCents ? beforeCents / 100_000 : (priceCents ? priceCents / 100_000 : null)
    const salePrice  = beforeCents && priceCents && beforeCents > priceCents ? priceCents / 100_000 : null

    return {
      title:      item.name ?? null,
      price,
      sale_price: salePrice,
      image_url:  allImages[0] ?? null,
      all_images: allImages,
      url:        input.url ?? null,
      platform:   'shopee',
      listing_id: `${shopId}.${itemId}`,
    }
  }

  // ── Auto-detect ─────────────────────────────────────────────────────────

  /** Detecta plataforma da URL e roteia. Usado pelo POST /campaigns/import-from-url */
  async scrapeFromUrl(url: string): Promise<ListingSummary> {
    const platform = this.scraper.detectPlatform(url)
    if (platform === 'mercadolivre') return this.scrapeMlListing({ url })
    if (platform === 'shopee')       return this.scrapeShopeeListing({ url })
    throw new BadRequestException(`Plataforma "${platform}" ainda não suportada pelo import de URL`)
  }
}
