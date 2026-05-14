/**
 * Wrapper dos endpoints públicos do ML que o Research Engine consome.
 *
 * Endpoints usados (todos públicos, sem auth necessária pra search):
 *   - GET /sites/MLB/search                      → top 50 da categoria
 *   - GET /items?ids=                            → detalhes de batch (date_created, etc)
 *   - GET /users/{seller_id}                     → reputação detalhada
 *   - GET /categories/{id}/attributes            → atributos obrigatórios/recomendados
 *
 * Rate limit: ML público permite ~1000 reqs/hora. Pra MVP 1 não esquentamos
 * cache aqui — quem cacheia é o CategoryResearchService (24h).
 */

import { Injectable, Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { retryWithBackoff } from '../../../common/retry'
import type { MlSearchHit, MlItemDetails, MlSellerReputation } from '../e-otimizer.types'

const ML_BASE = 'https://api.mercadolibre.com'

@Injectable()
export class MlSearchService {
  private readonly logger = new Logger(MlSearchService.name)

  /**
   * Busca top N anúncios numa categoria com query opcional.
   * Retorna até 50 hits ordenados por relevância (algoritmo do próprio ML).
   *
   * @param categoryId  ML category ID (ex: 'MLB1234')
   * @param query       palavras-chave (q=)
   * @param limit       máx 50 (limite duro do ML)
   */
  async searchCategory(args: {
    categoryId: string
    query?:     string
    limit?:     number
    condition?: 'new' | 'used'
  }): Promise<MlSearchHit[]> {
    const limit = Math.min(args.limit ?? 50, 50)
    const params: Record<string, string | number> = {
      category: args.categoryId,
      limit,
      offset:   0,
    }
    if (args.query) params.q = args.query
    if (args.condition) params.condition = args.condition

    try {
      const { data } = await retryWithBackoff(
        () => axios.get<{ results: unknown[] }>(`${ML_BASE}/sites/MLB/search`, {
          params,
          timeout: 15_000,
        }),
        { maxRetries: 2, baseMs: 800, label: 'ml.search' },
      )
      const results = (data.results ?? []) as Array<Record<string, unknown>>
      const hits: MlSearchHit[] = results.map((r, idx) => this.parseSearchHit(r, idx))
      this.logger.log(`[ml-search] category=${args.categoryId} q="${args.query ?? ''}" → ${hits.length} hits`)
      return hits
    } catch (e: unknown) {
      if (axios.isAxiosError(e)) {
        const ax = e as AxiosError<{ message?: string }>
        this.logger.warn(`[ml-search] falhou: ${ax.response?.status} ${ax.response?.data?.message ?? ax.message}`)
      } else {
        this.logger.warn(`[ml-search] falhou: ${(e as Error).message}`)
      }
      return []
    }
  }

  /**
   * Busca detalhes adicionais de um batch de items (até 20 IDs por call).
   * Usado pra pegar date_created (calcula days_on_air) — não vem no /search.
   */
  async getItemsDetails(itemIds: string[]): Promise<Map<string, MlItemDetails>> {
    const out = new Map<string, MlItemDetails>()
    if (itemIds.length === 0) return out

    // ML permite até 20 IDs por call no multi-get
    const chunks: string[][] = []
    for (let i = 0; i < itemIds.length; i += 20) {
      chunks.push(itemIds.slice(i, i + 20))
    }

    await Promise.all(chunks.map(async chunk => {
      try {
        const { data } = await retryWithBackoff(
          () => axios.get<Array<{ code: number; body?: Record<string, unknown> }>>(
            `${ML_BASE}/items`,
            { params: { ids: chunk.join(','), attributes: 'id,date_created,start_time,last_updated,status' }, timeout: 15_000 },
          ),
          { maxRetries: 2, baseMs: 800, label: 'ml.items.multiget' },
        )
        for (const entry of data ?? []) {
          if (entry.code === 200 && entry.body) {
            const b = entry.body as Record<string, string>
            out.set(b.id, {
              id:           b.id,
              date_created: b.date_created,
              start_time:   b.start_time,
              last_updated: b.last_updated,
              status:       b.status,
            })
          }
        }
      } catch (e) {
        this.logger.warn(`[ml-search.itemsDetails] falhou chunk: ${(e as Error).message}`)
      }
    }))
    return out
  }

  /**
   * Reputação do vendedor (com cache em memória curto pro batch atual).
   * Vários hits podem ter o mesmo seller — evita refetch.
   */
  async getSellerReputation(sellerId: number): Promise<MlSellerReputation | null> {
    try {
      const { data } = await retryWithBackoff(
        () => axios.get<{ seller_reputation?: Record<string, unknown> }>(`${ML_BASE}/users/${sellerId}`, {
          timeout: 10_000,
        }),
        { maxRetries: 2, baseMs: 800, label: 'ml.user' },
      )
      const rep = (data.seller_reputation ?? {}) as Record<string, unknown>
      const metrics = (rep.metrics ?? {}) as Record<string, unknown>
      return {
        level_id:            (rep.level_id as string | null) ?? null,
        power_seller_status: (rep.power_seller_status as 'platinum' | 'gold' | 'silver' | null) ?? null,
        metrics: {
          claims_rate:                  (metrics.claims as { rate?: number } | undefined)?.rate,
          delayed_handling_time_rate:   (metrics.delayed_handling_time as { rate?: number } | undefined)?.rate,
          cancellations_rate:           (metrics.cancellations as { rate?: number } | undefined)?.rate,
          sales: {
            period:    (metrics.sales as { period?: string } | undefined)?.period ?? '',
            completed: (metrics.sales as { completed?: number } | undefined)?.completed ?? 0,
          },
        },
      }
    } catch {
      return null
    }
  }

  /** Bulk version com dedup. */
  async getSellersReputation(sellerIds: number[]): Promise<Map<number, MlSellerReputation>> {
    const unique = Array.from(new Set(sellerIds))
    const out = new Map<number, MlSellerReputation>()
    // Paralelo, mas com cap de 5 simultâneos pra não estourar rate limit
    const batches: number[][] = []
    for (let i = 0; i < unique.length; i += 5) batches.push(unique.slice(i, i + 5))
    for (const batch of batches) {
      await Promise.all(batch.map(async id => {
        const r = await this.getSellerReputation(id)
        if (r) out.set(id, r)
      }))
    }
    return out
  }

  /** Atributos obrigatórios + recomendados de uma categoria. */
  async getCategoryAttributes(categoryId: string): Promise<Array<{
    id:             string
    name:           string
    value_type:     string
    tags?:          Record<string, boolean>   // { required?: true, ... }
    values?:        Array<{ id: string; name: string }>
    hint?:          string
  }>> {
    try {
      const { data } = await retryWithBackoff(
        () => axios.get<Array<Record<string, unknown>>>(
          `${ML_BASE}/categories/${encodeURIComponent(categoryId)}/attributes`,
          { timeout: 10_000 },
        ),
        { maxRetries: 2, baseMs: 800, label: 'ml.cat.attrs' },
      )
      return (data ?? []).map(a => ({
        id:         a.id as string,
        name:       a.name as string,
        value_type: a.value_type as string,
        tags:       (a.tags as Record<string, boolean> | undefined) ?? {},
        values:     a.values as Array<{ id: string; name: string }> | undefined,
        hint:       a.hint as string | undefined,
      }))
    } catch (e) {
      this.logger.warn(`[ml-search.catAttrs] falhou: ${(e as Error).message}`)
      return []
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private parseSearchHit(r: Record<string, unknown>, position: number): MlSearchHit {
    const seller = (r.seller ?? {}) as Record<string, unknown>
    const shipping = (r.shipping ?? {}) as Record<string, unknown>
    return {
      id:                 r.id as string,
      title:              r.title as string,
      price:              Number(r.price ?? 0),
      original_price:     r.original_price != null ? Number(r.original_price) : null,
      available_quantity: Number(r.available_quantity ?? 0),
      sold_quantity:      Number(r.sold_quantity ?? 0),
      condition:          (r.condition as MlSearchHit['condition']) ?? 'new',
      listing_type_id:    r.listing_type_id as string,
      category_id:        r.category_id as string,
      catalog_listing:    Boolean(r.catalog_listing),
      catalog_product_id: (r.catalog_product_id as string | null) ?? null,
      health:             r.health != null ? Number(r.health) : null,
      permalink:          r.permalink as string,
      thumbnail:          (r.thumbnail as string) ?? '',
      tags:               (r.tags as string[]) ?? [],
      shipping: {
        free_shipping: Boolean(shipping.free_shipping),
        logistic_type: (shipping.logistic_type as string | null) ?? null,
        mode:          (shipping.mode as string) ?? 'not_specified',
      },
      seller: {
        id:                  Number(seller.id ?? 0),
        nickname:            (seller.nickname as string) ?? '',
        power_seller_status: (seller.power_seller_status as 'platinum' | 'gold' | 'silver' | null) ?? null,
        car_dealer:          Boolean(seller.car_dealer),
        real_estate_agency:  Boolean(seller.real_estate_agency),
      },
      attributes:          (r.attributes as MlSearchHit['attributes']) ?? [],
      position_in_results: position,
    }
  }
}
