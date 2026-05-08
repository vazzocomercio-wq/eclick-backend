/** Cliente ML pra endpoints de campanhas. Mesma estrategia do F7
 *  Quality Center: backoff exponencial em 429 (1s..16s..60s), 3x 429
 *  consecutivos pausa o caller via RateLimitedException.
 *
 *  Endpoints validados em smoke-test (VAZZO_):
 *    - GET /seller-promotions/users/:id
 *    - GET /seller-promotions/promotions/:id/items (search_after pagination)
 *    - GET /seller-promotions/items/:itemId (subsidio MELI)
 *    - GET /seller-promotions/candidates/:id
 *    - GET /sites/MLB/listing_prices */

import { Injectable, Logger, HttpException } from '@nestjs/common'
import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import type {
  MlPromotionListItem,
  MlPromotionItem,
  MlItemPromotion,
  MlCampaignItemsResponse,
  MlListingPricesResponse,
} from './ml-campaigns.types'

const ML_BASE = 'https://api.mercadolibre.com'

export class CampaignsRateLimitedException extends Error {
  constructor(message: string) { super(message); this.name = 'CampaignsRateLimitedException' }
}

@Injectable()
export class MlCampaignsApiClient {
  private readonly logger = new Logger(MlCampaignsApiClient.name)
  private rateLimit429Count = new Map<number, number>()

  /** GET /seller-promotions/users/:id?app_version=v2
   *  Lista todas as campanhas elegiveis pro seller.
   *  IMPORTANTE: app_version=v2 eh OBRIGATORIO. Sem ele a resposta vem
   *  diferente. Wrapper sempre passa. */
  async listSellerPromotions(token: string, sellerId: number): Promise<MlPromotionListItem[]> {
    const r = await this.requestWithBackoff<{ results: MlPromotionListItem[]; paging?: any } | MlPromotionListItem[]>({
      method:  'GET',
      url:     `${ML_BASE}/seller-promotions/users/${sellerId}`,
      headers: { Authorization: `Bearer ${token}` },
      params:  { app_version: 'v2' },
    }, sellerId)
    return Array.isArray(r) ? r : (r.results ?? [])
  }

  /** GET /seller-promotions/promotions/:id/items
   *  Pagina via search_after. Pode receber status=candidate|started|pending. */
  async listCampaignItems(
    token:          string,
    sellerId:       number,
    promotionId:    string,
    promotionType:  string,
    options: {
      status?:      'candidate' | 'started' | 'pending'
      itemId?:      string
      searchAfter?: string
      limit?:       number
    } = {},
  ): Promise<MlCampaignItemsResponse> {
    const { status, itemId, searchAfter, limit = 50 } = options
    return this.requestWithBackoff<MlCampaignItemsResponse>({
      method:  'GET',
      url:     `${ML_BASE}/seller-promotions/promotions/${promotionId}/items`,
      headers: { Authorization: `Bearer ${token}` },
      params:  {
        promotion_type: promotionType,
        app_version:    'v2',
        limit,
        ...(status      && { status }),
        ...(itemId      && { item_id: itemId }),
        ...(searchAfter && { search_after: searchAfter }),
      },
    }, sellerId)
  }

  /** GET /seller-promotions/items/:itemId?app_version=v2
   *  Retorna TODAS as promoes elegiveis pra 1 item (array).
   *  ENDPOINT QUE TEM O SUBSIDIO (meli_percentage/seller_percentage). */
  async listItemPromotions(token: string, sellerId: number, itemId: string): Promise<MlItemPromotion[]> {
    const r = await this.requestWithBackoff<MlItemPromotion[]>({
      method:  'GET',
      url:     `${ML_BASE}/seller-promotions/items/${itemId}`,
      headers: { Authorization: `Bearer ${token}` },
      params:  { app_version: 'v2' },
    }, sellerId)
    return Array.isArray(r) ? r : []
  }

  /** GET /items?ids=X1,X2,...&attributes=...
   *  Batch fetch de metadata (max 20 ids por chamada). Inclui:
   *  - thumbnail/title/permalink (visual)
   *  - status (active/paused/closed/under_review)
   *  - catalog_listing (boolean — true se compete por buy box) */
  async getItemsMetadata(
    token:    string,
    sellerId: number,
    itemIds:  string[],
  ): Promise<Array<{
    id: string;
    thumbnail?: string;
    title?: string;
    permalink?: string;
    status?: string;
    catalog_listing?: boolean;
  }>> {
    if (itemIds.length === 0) return []
    const batch = itemIds.slice(0, 20)
    const r = await this.requestWithBackoff<Array<{ code: number; body?: { id: string; thumbnail?: string; title?: string; permalink?: string; status?: string; catalog_listing?: boolean } }>>({
      method:  'GET',
      url:     `${ML_BASE}/items`,
      headers: { Authorization: `Bearer ${token}` },
      params:  { ids: batch.join(','), attributes: 'id,thumbnail,title,permalink,status,catalog_listing' },
    }, sellerId)

    return r
      .filter(it => it.code === 200 && it.body?.id)
      .map(it => ({
        id:               it.body!.id,
        thumbnail:        it.body!.thumbnail,
        title:            it.body!.title,
        permalink:        it.body!.permalink,
        status:           it.body!.status,
        catalog_listing:  it.body!.catalog_listing,
      }))
  }

  /** POST /seller-promotions/offers
   *  Cria oferta (lojista adere a campanha pra item especifico).
   *  Body shape varia por promotion_type. Exemplo DEAL:
   *  { promotion_id, promotion_type, item_id, offer_price, offer_quantity? }
   *  Retorna { id (offer_id), status, ... } */
  async createOffer(token: string, sellerId: number, body: Record<string, unknown>): Promise<{ id?: string; offer_id?: string; status?: string; [k: string]: unknown }> {
    return this.requestWithBackoff<{ id?: string; offer_id?: string; status?: string; [k: string]: unknown }>({
      method:  'POST',
      url:     `${ML_BASE}/seller-promotions/offers`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      params:  { app_version: 'v2' },
      data:    body,
    }, sellerId)
  }

  /** DELETE /seller-promotions/offers/:offerId
   *  Remove oferta (sai da campanha).
   *  Para PRICE_DISCOUNT/DOD/LIGHTNING usado tambem pra "edit-recreate"
   *  (deletar + recriar). Em v1 so usado pra leave/single. */
  async deleteOffer(token: string, sellerId: number, offerId: string, promotionType: string): Promise<unknown> {
    return this.requestWithBackoff<unknown>({
      method:  'DELETE',
      url:     `${ML_BASE}/seller-promotions/offers/${offerId}`,
      headers: { Authorization: `Bearer ${token}` },
      params:  { app_version: 'v2', promotion_type: promotionType },
    }, sellerId)
  }

  /** GET /sites/MLB/listing_prices — sem auth seller especifica.
   *  Retorna comissao + frete gratis pra (categoria, faixa de preco, logistica). */
  async getListingPrices(token: string, params: {
    categoryId:     string
    listingTypeId?: string
    price:          number
    logisticType?:  string
    shippingMode?:  string
  }): Promise<MlListingPricesResponse> {
    return this.requestWithBackoff<MlListingPricesResponse>({
      method:  'GET',
      url:     `${ML_BASE}/sites/MLB/listing_prices`,
      headers: { Authorization: `Bearer ${token}` },
      params:  {
        category_id:     params.categoryId,
        listing_type_id: params.listingTypeId ?? 'gold_special',
        price:           params.price,
        ...(params.logisticType && { logistic_type: params.logisticType }),
        ...(params.shippingMode && { shipping_mode: params.shippingMode }),
      },
    }, 0)
  }

  // ── Private ─────────────────────────────────────────────────────

  private async requestWithBackoff<T>(config: AxiosRequestConfig, sellerId: number, attempt = 0): Promise<T> {
    const DELAYS_MS = [0, 1000, 2000, 4000, 8000, 16000, 60000]
    const MAX_ATTEMPTS = DELAYS_MS.length

    if (attempt > 0) {
      await new Promise(r => setTimeout(r, DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)]))
    }

    try {
      const r = await axios.request<T>(config)
      this.rateLimit429Count.set(sellerId, 0)
      return r.data
    } catch (e) {
      const err = e as AxiosError
      const status = err.response?.status

      if (status === 429) {
        const count = (this.rateLimit429Count.get(sellerId) ?? 0) + 1
        this.rateLimit429Count.set(sellerId, count)

        if (count >= 3) {
          this.logger.error(`[ml-campaigns] 3x 429 consecutivos seller=${sellerId} — pausando job`)
          throw new CampaignsRateLimitedException(
            `ML API rate limit excedido (3x 429). Job pausado pra seller ${sellerId}.`,
          )
        }
        if (attempt >= MAX_ATTEMPTS - 1) {
          throw new HttpException(`ML API rate limit (apos ${attempt} retries)`, 429)
        }

        this.logger.warn(`[ml-campaigns] 429 (tentativa ${attempt + 1}/${MAX_ATTEMPTS}) — aguardando ${DELAYS_MS[attempt + 1]}ms`)
        return this.requestWithBackoff<T>(config, sellerId, attempt + 1)
      }

      const msg = (err.response?.data as any)?.message ?? err.message
      throw new HttpException(`ML API ${status ?? '?'}: ${msg}`, status ?? 500)
    }
  }
}
