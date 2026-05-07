/** Cliente ML pra endpoints de qualidade. Backoff exponencial em 429
 *  (1s, 2s, 4s, 8s, 16s, max 60s). 3 x 429 seguidos pausa o caller
 *  via throw RateLimitedException. */

import { Injectable, Logger, HttpException } from '@nestjs/common'
import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import type { MlCatalogQualityResponse } from './ml-quality.types'

const ML_BASE = 'https://api.mercadolibre.com'

interface FetchAttrs {
  id:         string
  name:       string
  tags?:      Record<string, boolean>
  hierarchy?: string
  relevance?: number
  value_type?: string
  values?:    Array<{ id: string; name: string }>
  allowed_units?: string[]
  value_max_length?: number
  hint?:      string
  attribute_group_id?: string
  attribute_group_name?: string
}

export class RateLimitedException extends Error {
  constructor(message: string) { super(message); this.name = 'RateLimitedException' }
}

@Injectable()
export class MlQualityApiClient {
  private readonly logger = new Logger(MlQualityApiClient.name)
  /** Counter de 429 consecutivos por seller — reset em sucesso. */
  private rateLimit429Count = new Map<number, number>()

  /** GET /catalog_quality/status?seller_id=X&include_items=true&v=1
   *  Endpoint primario pro Quality Center. 1 chamada retorna TODOS items
   *  com adoption_status agrupado por dominio. */
  async getCatalogQualityStatus(token: string, sellerId: number): Promise<MlCatalogQualityResponse> {
    return this.requestWithBackoff<MlCatalogQualityResponse>({
      method: 'GET',
      url:    `${ML_BASE}/catalog_quality/status`,
      headers: { Authorization: `Bearer ${token}` },
      params: { seller_id: sellerId, include_items: true, v: 1 },
    }, sellerId)
  }

  /** GET /users/:userId/items/search?tags=incomplete_technical_specs
   *  Detecta items penalizados por completude. Pagina via offset/limit. */
  async searchItemsByTag(token: string, sellerId: number, tag: string): Promise<{ ids: string[]; total: number }> {
    const ids: string[] = []
    let offset = 0
    let total  = 0
    const LIMIT = 50

    do {
      const r = await this.requestWithBackoff<{ results: string[]; paging: { total: number } }>({
        method: 'GET',
        url:    `${ML_BASE}/users/${sellerId}/items/search`,
        headers: { Authorization: `Bearer ${token}` },
        params: { tags: tag, limit: LIMIT, offset },
      }, sellerId)
      ids.push(...(r.results ?? []))
      total = r.paging?.total ?? ids.length
      offset += LIMIT
      if (ids.length >= total) break
      if (offset >= 1000) break // safety cap
    } while (true)

    return { ids, total }
  }

  /** GET /categories/:id/attributes — cache 7d em ml_category_attributes. */
  async getCategoryAttributes(token: string, categoryId: string): Promise<FetchAttrs[]> {
    return this.requestWithBackoff<FetchAttrs[]>({
      method: 'GET',
      url:    `${ML_BASE}/categories/${categoryId}/attributes`,
      headers: { Authorization: `Bearer ${token}` },
    }, 0) // categoryId nao tem seller, usa 0 pro counter
  }

  /** Wrapper com retry + backoff exponencial pra 429.
   *  3 x 429 consecutivos pro mesmo seller -> throw RateLimitedException
   *  e o caller pausa o job. */
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
        const count429 = (this.rateLimit429Count.get(sellerId) ?? 0) + 1
        this.rateLimit429Count.set(sellerId, count429)

        if (count429 >= 3) {
          this.logger.error(`[ml-quality] 3x 429 consecutivos pra seller ${sellerId} — pausando job`)
          throw new RateLimitedException(
            `ML API rate limit excedido (3x 429). Job pausado pra seller ${sellerId}. Aguarde alguns minutos.`,
          )
        }

        if (attempt >= MAX_ATTEMPTS - 1) {
          throw new HttpException(`ML API rate limit (apos ${attempt} retries)`, 429)
        }

        this.logger.warn(`[ml-quality] 429 (tentativa ${attempt + 1}/${MAX_ATTEMPTS}) — aguardando ${DELAYS_MS[attempt + 1]}ms`)
        return this.requestWithBackoff<T>(config, sellerId, attempt + 1)
      }

      // Outros erros sobem direto
      const msg = (err.response?.data as any)?.message ?? err.message
      throw new HttpException(`ML API ${status ?? '?'}: ${msg}`, status ?? 500)
    }
  }
}
