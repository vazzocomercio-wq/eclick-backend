import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { OpportunitiesService } from './opportunities.service'
import { FetchReviewsResult, MlReview } from './opportunities.types'

const ML_API    = 'https://api.mercadolibre.com'
const PAGE_SIZE = 50
/** Teto de reviews por item — 8 páginas cobre a faixa pageable típica (~450)
 *  sem estourar rate limit nem custo de contexto na mineração. */
const MAX_PAGES_PER_ITEM = 8

/**
 * Radar de Encaixe — Peça 2: puxar as avaliações do hospedeiro pro cache.
 *
 * Varre /reviews/item/{id} paginado (limit=50) pra cada anúncio do host e
 * grava em opp_review. O minerador de dores lê DALI, nunca da API direto —
 * evidência fica auditável (frase literal + review_id + estrela).
 */
@Injectable()
export class ReviewFetcherService {
  private readonly logger = new Logger(ReviewFetcherService.name)

  constructor(private readonly opp: OpportunitiesService) {}

  async fetchForHost(orgId: string, hostId: string): Promise<FetchReviewsResult> {
    const host  = await this.opp.getHost(orgId, hostId)
    const token = await this.opp.mlToken(orgId)
    const result: FetchReviewsResult = { total: 0, fetched: 0, inserted: 0, pages: 0, errors: [] }

    for (const itemId of host.item_ids.length > 0 ? host.item_ids : [host.anchor_item_id]) {
      let offset = 0
      let pageable = Infinity
      for (let page = 0; page < MAX_PAGES_PER_ITEM && offset < pageable; page++) {
        let body: { paging?: { total?: number; total_pageable?: number }; reviews?: MlReview[] }
        try {
          const res = await axios.get(`${ML_API}/reviews/item/${itemId}`, {
            params: { limit: PAGE_SIZE, offset },
            headers: { Authorization: `Bearer ${token}` },
            timeout: 20_000,
          })
          body = res.data as typeof body
        } catch (e) {
          result.errors.push(`${itemId} offset=${offset}: ${this.opp.errMsg(e)}`)
          break
        }
        result.pages++
        pageable = body.paging?.total_pageable ?? 0
        result.total = Math.max(result.total, body.paging?.total ?? 0)
        const reviews = body.reviews ?? []
        if (reviews.length === 0) break
        result.fetched += reviews.length

        const rows = reviews.map(r => ({
          organization_id: orgId,
          host_id:         hostId,
          item_id:         itemId,
          external_id:     String(r.id),
          rate:            r.rate,
          title:           r.title || null,
          content:         (r.content ?? '').trim() || null,
          likes:           r.likes ?? 0,
          reviewed_at:     r.date_created ?? null,
        }))
        const { error, count } = await supabaseAdmin.from('opp_review')
          .upsert(rows, { onConflict: 'organization_id,host_id,external_id', count: 'exact' })
        if (error) result.errors.push(`upsert ${itemId}: ${error.message}`)
        else result.inserted += count ?? rows.length

        offset += PAGE_SIZE
      }
    }

    // fotografia no host (contadores + carimbo)
    const { count: cached } = await supabaseAdmin.from('opp_review')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('host_id', hostId)
    await supabaseAdmin.from('opp_host').update({
      reviews_fetched:    cached ?? result.fetched,
      reviews_total:      result.total,
      reviews_fetched_at: new Date().toISOString(),
      updated_at:         new Date().toISOString(),
    }).eq('organization_id', orgId).eq('id', hostId)

    this.logger.log(`[opp.fetch] host=${hostId} total=${result.total} fetched=${result.fetched} pages=${result.pages} errs=${result.errors.length}`)
    return result
  }
}
