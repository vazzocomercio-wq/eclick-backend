import { Injectable, HttpException } from '@nestjs/common'
import axios from 'axios'
import * as cheerio from 'cheerio'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
}

export interface ScrapedProduct {
  title: string | null
  price: number | null
  price_max?: number | null
  seller: string | null
  available_quantity?: number | null
  sold_quantity?: number | null
  thumbnail?: string | null
  free_shipping?: boolean | null
  rating?: number | null
  listing_id?: string | null
  platform: string
  method: string
}

@Injectable()
export class ScraperService {

  detectPlatform(url: string): string {
    if (/mercadolivre\.com\.br|mercadolibre\.com/i.test(url)) return 'mercadolivre'
    if (/shopee\.com\.br/i.test(url)) return 'shopee'
    if (/amazon\.com\.br/i.test(url)) return 'amazon'
    if (/magazineluiza\.com\.br|magalu\.com\.br/i.test(url)) return 'magalu'
    if (/americanas\.com\.br/i.test(url)) return 'americanas'
    return 'unknown'
  }

  async scrapeMercadoLivre(url: string): Promise<ScrapedProduct> {
    const mlbMatch = url.match(/MLB[UBub]?(\d+)/i)

    if (mlbMatch) {
      const mlbId = `MLB${mlbMatch[1]}`
      try {
        const { data } = await axios.get(
          `https://api.mercadolibre.com/items/${mlbId}`,
          {
            headers: HEADERS,
            params: { attributes: 'id,title,price,available_quantity,sold_quantity,thumbnail,seller_id,shipping,listing_type_id' },
          },
        )
        return {
          title:              data.title ?? null,
          price:              data.price ?? null,
          seller:             data.seller?.nickname ?? null,
          available_quantity: data.available_quantity ?? null,
          sold_quantity:      data.sold_quantity ?? null,
          thumbnail:          data.thumbnail ?? null,
          free_shipping:      data.shipping?.free_shipping ?? null,
          listing_id:         mlbId,
          platform:           'mercadolivre',
          method:             'api',
        }
      } catch { /* fall back to HTML scrape */ }
    }

    const { data: html } = await axios.get(url, { headers: HEADERS })
    const $ = cheerio.load(html)

    let price: number | null = null
    let title: string | null = null
    let seller: string | null = null

    $("script[type='application/ld+json']").each((_i, el) => {
      try {
        const json = JSON.parse($(el).html() ?? '')
        if (json?.offers?.price) price = parseFloat(json.offers.price)
        if (json?.name) title = json.name
        if (json?.seller?.name) seller = json.seller.name
      } catch {}
    })

    if (!price) {
      const match = html.match(/"price":(\d+(?:\.\d+)?)/)
      if (match) price = parseFloat(match[1])
    }

    if (!price) {
      const frac = $(".andes-money-amount__fraction").first().text().replace(/\./g, '')
      const cents = $(".andes-money-amount__cents").first().text()
      if (frac) price = parseFloat(frac) + (cents ? parseInt(cents) / 100 : 0)
    }

    if (!title) title = $("h1.ui-pdp-title").text().trim() || null
    if (!seller) seller = $(".ui-pdp-seller__link-trigger-button span").text().trim() || null

    if (!title) {
      const slug = url.match(/mercadolivre\.com\.br\/([^/?#]+)/)?.[1]
      if (slug) title = decodeURIComponent(slug).replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    }

    return { title, price, seller, platform: 'mercadolivre', method: 'html' }
  }

  async scrapeShopee(url: string): Promise<ScrapedProduct> {
    const match = url.match(/i\.(\d+)\.(\d+)/)
    if (!match) throw new HttpException('URL da Shopee inválida — formato esperado: /nome-produto-i.SHOPID.ITEMID', 400)

    const shopId = match[1]
    const itemId = match[2]

    const { data: res } = await axios.get(
      `https://shopee.com.br/api/v4/item/get?itemid=${itemId}&shopid=${shopId}`,
      {
        headers: {
          ...HEADERS,
          'Referer': 'https://shopee.com.br/',
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
    )

    const item = res?.data?.item
    if (!item) throw new HttpException('Item não encontrado na Shopee', 404)

    return {
      title:              item.name ?? null,
      price:              item.price_min != null ? item.price_min / 100000 : null,
      price_max:          item.price_max != null ? item.price_max / 100000 : null,
      seller:             item.shop_name ?? null,
      available_quantity: item.stock ?? null,
      sold_quantity:      item.historical_sold ?? null,
      thumbnail:          item.image ? `https://cf.shopee.com.br/file/${item.image}` : null,
      free_shipping:      item.show_free_shipping ?? null,
      rating:             item.item_rating?.rating_star ?? null,
      listing_id:         `${shopId}.${itemId}`,
      platform:           'shopee',
      method:             'api',
    }
  }

  async scrapeAmazon(url: string): Promise<ScrapedProduct> {
    const { data: html } = await axios.get(url, {
      headers: { ...HEADERS, 'Accept': 'text/html,application/xhtml+xml' },
    })
    const $ = cheerio.load(html)

    const title = $("#productTitle").text().trim() || null

    let price: number | null = null
    const whole = $(".a-price-whole").first().text().replace(/[^\d]/g, '')
    const frac  = $(".a-price-fraction").first().text().replace(/[^\d]/g, '')
    if (whole) price = parseFloat(whole + '.' + (frac || '00'))

    if (!price) {
      const m = html.match(/"priceAmount":(\d+\.?\d*)/)
      if (m) price = parseFloat(m[1])
    }

    const seller =
      $("#sellerProfileTriggerId").text().trim() ||
      $("#merchant-info a").first().text().trim() ||
      null

    return { title, price, seller, platform: 'amazon', method: 'html' }
  }

  async scrapeMagalu(url: string): Promise<ScrapedProduct> {
    const { data: html } = await axios.get(url, { headers: HEADERS })

    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!match) throw new HttpException('Não foi possível extrair dados da Magazine Luiza', 422)

    const json = JSON.parse(match[1])
    const product = json?.props?.pageProps?.product

    return {
      title:              product?.title ?? null,
      price:              product?.price ?? null,
      seller:             product?.seller?.name ?? 'Magazine Luiza',
      available_quantity: product?.stock ?? null,
      thumbnail:          product?.image ?? null,
      free_shipping:      product?.freeShipping ?? null,
      platform:           'magalu',
      method:             'next_data',
    }
  }

  async scrapeProduct(url: string): Promise<ScrapedProduct> {
    const platform = this.detectPlatform(url)

    try {
      switch (platform) {
        case 'mercadolivre': return await this.scrapeMercadoLivre(url)
        case 'shopee':       return await this.scrapeShopee(url)
        case 'amazon':       return await this.scrapeAmazon(url)
        case 'magalu':       return await this.scrapeMagalu(url)
        default:             throw new HttpException(`Plataforma não suportada: ${url}`, 422)
      }
    } catch (e: any) {
      console.error(`[scraper] erro em ${platform}:`, e.message)
      if (e instanceof HttpException) throw e
      throw new HttpException(`Erro ao buscar dados: ${e.message}`, 502)
    }
  }
}
