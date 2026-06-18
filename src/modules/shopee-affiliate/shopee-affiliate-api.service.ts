import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'crypto'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql'

export interface ProductOffer {
  itemId:            number
  productName:       string
  commissionRate:   number   // 0-1
  commission:       number
  price:            number
  sales:            number    // VENDAS REAIS
  imageUrl:         string
  shopName:         string
  shopId:           number
  ratingStar:       number    // 0-5
  priceDiscountRate: number   // %
  productLink:      string
  offerLink:        string
  productCatIds:    number[]
}

interface Creds { appId: string; secret: string }

/** F18 Sprint 2 — cliente da Shopee Affiliate Open API (GraphQL + assinatura
 *  SHA256). Lê app_id/secret de shopee.affiliate_connections (service_role).
 *  É o único ponto que toca a API externa de afiliados. */
@Injectable()
export class ShopeeAffiliateApiService {
  private readonly logger = new Logger(ShopeeAffiliateApiService.name)

  /** Credenciais da org (org-specific → fallback env). null = não conectado. */
  private async creds(orgId: string): Promise<Creds | null> {
    const { data } = await supabaseAdmin
      .schema('shopee')
      .from('affiliate_connections')
      .select('app_id, app_secret, status')
      .eq('organization_id', orgId)
      .maybeSingle()
    const row = data as { app_id: string | null; app_secret: string | null; status: string | null } | null
    if (row?.app_id && row?.app_secret && row.status === 'active') {
      return { appId: row.app_id, secret: row.app_secret }
    }
    const envId = process.env.SHOPEE_AFFILIATE_APP_ID
    const envSecret = process.env.SHOPEE_AFFILIATE_SECRET
    if (envId && envSecret) return { appId: envId, secret: envSecret }
    return null
  }

  async hasCreds(orgId: string): Promise<boolean> {
    return (await this.creds(orgId)) != null
  }

  /** Executa um GraphQL assinado. Lança em erro de credencial/HTTP. */
  private async call<T>(orgId: string, query: string): Promise<T> {
    const c = await this.creds(orgId)
    if (!c) throw new Error('Shopee Affiliate API não conectada (app_id/secret ausentes).')
    const payload = JSON.stringify({ query })
    const ts = Math.floor(Date.now() / 1000)
    const sign = createHash('sha256').update(`${c.appId}${ts}${payload}${c.secret}`).digest('hex')
    const res = await axios.post(ENDPOINT, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SHA256 Credential=${c.appId}, Timestamp=${ts}, Signature=${sign}`,
      },
      timeout: 20000,
    })
    if (res.data?.errors?.length) {
      throw new Error(`Shopee API: ${JSON.stringify(res.data.errors).slice(0, 200)}`)
    }
    return res.data?.data as T
  }

  /** Busca uma página de produtos. sortType 2 = mais vendidos. */
  async productOffers(args: {
    orgId: string; keyword?: string | null; catId?: number | null
    sortType?: number; page?: number; limit?: number
  }): Promise<{ offers: ProductOffer[]; hasNext: boolean }> {
    const parts: string[] = [
      `sortType: ${args.sortType ?? 2}`,
      `page: ${args.page ?? 1}`,
      `limit: ${Math.min(args.limit ?? 50, 50)}`,
    ]
    if (args.keyword) parts.push(`keyword: ${JSON.stringify(args.keyword)}`)
    if (args.catId)   parts.push(`productCatId: ${args.catId}`)
    const query = `{ productOfferV2(${parts.join(', ')}) {
      nodes { itemId productName commissionRate commission price sales imageUrl shopName shopId ratingStar priceDiscountRate productLink offerLink productCatIds }
      pageInfo { page limit hasNextPage }
    } }`
    const data = await this.call<{ productOfferV2: { nodes: ProductOffer[]; pageInfo: { hasNextPage: boolean } } }>(args.orgId, query)
    return {
      offers:  data?.productOfferV2?.nodes ?? [],
      hasNext: data?.productOfferV2?.pageInfo?.hasNextPage ?? false,
    }
  }

  /** Gera link de afiliado rastreável pra um produto (ângulo monetização). */
  async generateAffiliateLink(orgId: string, productLink: string, subId?: string): Promise<string | null> {
    const sub = subId ? `, subIds: ${JSON.stringify([subId])}` : ''
    const query = `mutation { generateShortLink(input: { originUrl: ${JSON.stringify(productLink)}${sub} }) { shortLink } }`
    try {
      const data = await this.call<{ generateShortLink: { shortLink: string } }>(orgId, query)
      return data?.generateShortLink?.shortLink ?? null
    } catch (e) {
      this.logger.warn(`[shopee.aff] generateShortLink falhou: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }
}
