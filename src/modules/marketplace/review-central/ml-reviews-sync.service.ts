import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

/** Central de Avaliações — ingestão do MERCADO LIVRE.
 *
 *  GET /reviews/item/{MLB} por anúncio vinculado (paging) → upsert em
 *  marketplace_reviews (platform='mercadolivre'). Shape validado live:
 *  id, rate (1-5), title, content, date_created, order_id, media[],
 *  reviewer_id (0 = anônimo).
 *
 *  ⚠️ O ML NÃO permite resposta do vendedor a avaliações (nem API nem site —
 *  review é do produto de catálogo). editable='NOT_SUPPORTED' marca isso;
 *  o fluxo de negativa vira alerta + tarefa no Active (operador aciona o
 *  comprador via mensagem pós-venda, se fizer sentido). */
@Injectable()
export class MlReviewsSyncService {
  private readonly logger = new Logger(MlReviewsSyncService.name)
  private static readonly MAX_ITEMS_PER_TICK = 300
  private static readonly PAGE_SIZE = 50

  constructor(private readonly mercadolivre: MercadolivreService) {}

  @Cron('50 */6 * * *', { name: 'ml-reviews-sync' })
  async syncTick(): Promise<void> {
    if (process.env.ML_REVIEW_SYNC !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
      .not('access_token', 'is', null)
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.syncReviews(orgId)
      } catch (e) {
        this.logger.warn(`[ml.reviews.cron] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Varre os anúncios ML vinculados da org e upserta as avaliações. */
  async syncReviews(orgId: string): Promise<{ items: number; reviews: number }> {
    let token: string
    try {
      const r = await this.mercadolivre.getTokenForOrg(orgId)
      token = r.token
    } catch {
      throw new NotFoundException('Conta Mercado Livre não conectada nesta organização')
    }

    // anúncios da org via vínculo produto (product_listings não tem org —
    // escopo vem de products.organization_id)
    const { data: links } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, products!inner(organization_id)')
      .eq('platform', 'mercadolivre')
      .eq('is_active', true)
      .eq('products.organization_id', orgId)
      .limit(MlReviewsSyncService.MAX_ITEMS_PER_TICK)
    const itemIds = [...new Set((links ?? []).map(l => String(l.listing_id)).filter(Boolean))]
    if (!itemIds.length) return { items: 0, reviews: 0 }

    let saved = 0
    for (const itemId of itemIds) {
      try {
        saved += await this.syncItem(orgId, token, itemId)
      } catch (e: unknown) {
        this.logger.debug(`[ml.reviews] ${itemId}: ${(e as Error)?.message}`)
      }
      await new Promise(r => setTimeout(r, 120)) // gentileza com o rate limit
    }
    this.logger.log(`[ml.reviews] org=${orgId} itens=${itemIds.length} upserts=${saved}`)
    return { items: itemIds.length, reviews: saved }
  }

  private async syncItem(orgId: string, token: string, itemId: string): Promise<number> {
    let offset = 0
    let saved = 0
    for (let page = 0; page < 6; page++) { // cap 300 reviews/anúncio
      const { data } = await axios.get<Json>(
        `https://api.mercadolibre.com/reviews/item/${itemId}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params:  { limit: MlReviewsSyncService.PAGE_SIZE, offset },
          timeout: 15_000,
        },
      )
      const reviews: Json[] = data?.reviews ?? []
      if (!reviews.length) break

      for (const r of reviews) {
        if (r?.id == null) continue
        const comment = [r.title, r.content].filter(Boolean).join(' — ').trim() || null
        const { error } = await supabaseAdmin.from('marketplace_reviews').upsert(
          {
            organization_id:    orgId,
            platform:           'mercadolivre',
            shop_id:            null,
            external_review_id: String(r.id),
            item_id:            itemId,
            order_sn:           r.order_id != null ? String(r.order_id) : null,
            buyer_username:     null, // ML anonimiza o avaliador
            rating:             Number(r.rate) || null,
            comment,
            media:              { media: r.media ?? [] },
            reply_text:         null,
            editable:           'NOT_SUPPORTED', // ML não permite resposta pública
            hidden:             r.status !== 'published',
            review_create_at:   r.date_created ?? null,
            raw:                r,
            updated_at:         new Date().toISOString(),
          },
          { onConflict: 'organization_id,platform,external_review_id' },
        )
        if (!error) saved++
      }

      offset += MlReviewsSyncService.PAGE_SIZE
      const total = Number(data?.paging?.total ?? 0)
      if (offset >= total) break
    }
    return saved
  }
}
