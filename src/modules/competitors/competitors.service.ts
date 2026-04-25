import { Injectable, HttpException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

const ML_BASE = 'https://api.mercadolibre.com'

export interface CreateCompetitorDto {
  product_id: string
  platform: string
  url: string
  listing_id?: string | null
  title?: string | null
  seller?: string | null
  current_price: number
  my_price?: number | null
  photo_url?: string | null
}

@Injectable()
export class CompetitorsService {

  // ── Core CRUD ────────────────────────────────────────────────────────────────

  async create(orgId: string, dto: CreateCompetitorDto) {
    const { data: competitor, error } = await supabaseAdmin
      .from('competitors')
      .insert({
        organization_id: orgId,
        product_id:      dto.product_id,
        platform:        dto.platform,
        url:             dto.url,
        listing_id:      dto.listing_id ?? null,
        title:           dto.title    ?? null,
        seller:          dto.seller   ?? null,
        current_price:   dto.current_price,
        my_price:        dto.my_price ?? null,
        photo_url:       dto.photo_url ?? null,
        status:          'active',
        last_checked:    new Date().toISOString(),
      })
      .select('id, product_id, platform, url, title, seller, current_price, my_price, photo_url, status, last_checked, created_at')
      .single()

    if (error || !competitor) {
      console.error('[competitors.create] erro:', error)
      throw new HttpException(error?.message ?? 'Erro ao criar concorrente', 400)
    }

    try {
      await supabaseAdmin
        .from('price_history')
        .insert({ competitor_id: competitor.id, price: dto.current_price })
    } catch (e: any) {
      console.warn('[competitors.create] price_history insert failed:', e.message)
    }

    return competitor
  }

  async list(orgId: string, productId?: string) {
    let q = supabaseAdmin
      .from('competitors')
      .select('id, product_id, platform, url, title, seller, current_price, my_price, photo_url, status, last_checked, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (productId) q = q.eq('product_id', productId)

    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async remove(orgId: string, id: string) {
    const { error } = await supabaseAdmin
      .from('competitors')
      .delete()
      .eq('id', id)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Detail & History ─────────────────────────────────────────────────────────

  async getOne(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('competitors')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .single()

    if (error || !data) throw new HttpException('Concorrente não encontrado', 404)

    const { data: history } = await supabaseAdmin
      .from('competitor_price_history')
      .select('price, available_quantity, sold_quantity, checked_at')
      .eq('competitor_id', id)
      .order('checked_at', { ascending: false })
      .limit(180)

    return { ...data, price_history: history ?? [] }
  }

  // ── ML Enrichment ────────────────────────────────────────────────────────────

  async enrichFromML(listingId: string): Promise<Record<string, unknown>> {
    const attrs = 'id,title,price,available_quantity,sold_quantity,thumbnail,pictures,seller,shipping,listing_type_id,permalink,category_id,date_created,last_updated,health,attributes'

    const [itemRes, visitsRes, descRes, reviewsRes] = await Promise.allSettled([
      axios.get(`${ML_BASE}/items/${listingId}`, { params: { attributes: attrs } }),
      axios.get(`${ML_BASE}/items/${listingId}/visits`, { params: { last: 30 } }),
      axios.get(`${ML_BASE}/items/${listingId}/description`),
      axios.get(`${ML_BASE}/reviews/item/${listingId}`),
    ])

    if (itemRes.status === 'rejected') {
      const status = (itemRes.reason as any)?.response?.status ?? 500
      throw new HttpException(`Item ${listingId} não encontrado na ML`, status)
    }

    const item     = itemRes.value.data
    const visits   = visitsRes.status === 'fulfilled'  ? visitsRes.value.data   : {}
    const desc     = descRes.status === 'fulfilled'    ? descRes.value.data     : {}
    const reviews  = reviewsRes.status === 'fulfilled' ? reviewsRes.value.data  : {}

    return {
      ...item,
      visits_30d:    visits?.total_visits    ?? 0,
      description:   desc?.plain_text        ?? '',
      rating:        reviews?.rating_average ?? 0,
      reviews_total: reviews?.total          ?? 0,
      enriched_at:   new Date().toISOString(),
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────

  async saveSnapshot(competitorId: string, price: number, availableQty: number, soldQty: number) {
    const { error } = await supabaseAdmin
      .from('competitor_price_history')
      .insert({ competitor_id: competitorId, price, available_quantity: availableQty, sold_quantity: soldQty })
    if (error) console.warn('[competitors] snapshot insert failed:', error.message)
  }

  // ── Refresh ───────────────────────────────────────────────────────────────────

  async refresh(orgId: string, id: string) {
    const { data: row, error } = await supabaseAdmin
      .from('competitors')
      .select('id, url, platform, organization_id')
      .eq('id', id)
      .eq('organization_id', orgId)
      .single()

    if (error || !row) throw new HttpException('Concorrente não encontrado', 404)

    const mlbMatch = row.url?.match(/MLB[UBub]?(\d+)/i)
    const listingId = mlbMatch ? `MLB${mlbMatch[1]}` : null

    let enriched: Record<string, unknown> = {}
    if (listingId) {
      enriched = await this.enrichFromML(listingId)
    }

    const price = (enriched.price as number) ?? 0
    const qty   = (enriched.available_quantity as number) ?? 0
    const sold  = (enriched.sold_quantity as number) ?? 0

    if (price > 0) {
      const sellerNickname = (enriched as any)?.seller?.nickname ?? undefined
      await supabaseAdmin.from('competitors').update({
        current_price:     price,
        available_quantity: qty,
        sold_quantity:     sold,
        title:             (enriched.title as string) ?? undefined,
        photo_url:         (enriched.thumbnail as string) ?? undefined,
        seller:            sellerNickname,
        seller_nickname:   sellerNickname,
        seller_reputation: (enriched as any)?.seller?.seller_reputation?.level_id ?? undefined,
        rating:            (enriched.rating as number) ?? undefined,
        reviews_total:     (enriched.reviews_total as number) ?? undefined,
        visits_30d:        (enriched.visits_30d as number) ?? undefined,
        listing_type:      (enriched.listing_type_id as string) ?? undefined,
        free_shipping:     (enriched as any)?.shipping?.free_shipping ?? undefined,
        enriched_at:       new Date().toISOString(),
        last_checked:      new Date().toISOString(),
      }).eq('id', id)

      await this.saveSnapshot(id, price, qty, sold)
    }

    const base = await this.getOne(orgId, id)
    return { ...base, ml_data: enriched }
  }

  // ── Scheduled poll ────────────────────────────────────────────────────────────

  @Cron('0 */6 * * *')
  async pollAllCompetitors() {
    console.log('[competitors] polling all active competitors…')
    const { data: all } = await supabaseAdmin
      .from('competitors')
      .select('id, url')
      .eq('status', 'active')

    if (!all?.length) return

    let ok = 0, fail = 0
    for (const c of all) {
      try {
        const mlbMatch = c.url?.match(/MLB[UBub]?(\d+)/i)
        if (!mlbMatch) { fail++; continue }
        const listingId = `MLB${mlbMatch[1]}`
        const enriched  = await this.enrichFromML(listingId)
        const price = (enriched.price as number) ?? 0
        const qty   = (enriched.available_quantity as number) ?? 0
        const sold  = (enriched.sold_quantity as number) ?? 0
        if (price > 0) {
          const sellerNickname = (enriched as any)?.seller?.nickname ?? undefined
          await supabaseAdmin.from('competitors').update({
            current_price:     price,
            available_quantity: qty,
            sold_quantity:     sold,
            seller:            sellerNickname,
            seller_nickname:   sellerNickname,
            seller_reputation: (enriched as any)?.seller?.seller_reputation?.level_id ?? undefined,
            rating:            (enriched.rating as number) ?? undefined,
            reviews_total:     (enriched.reviews_total as number) ?? undefined,
            visits_30d:        (enriched.visits_30d as number) ?? undefined,
            listing_type:      (enriched.listing_type_id as string) ?? undefined,
            free_shipping:     (enriched as any)?.shipping?.free_shipping ?? undefined,
            enriched_at:       new Date().toISOString(),
            last_checked:      new Date().toISOString(),
          }).eq('id', c.id)
          await this.saveSnapshot(c.id, price, qty, sold)
        }
        ok++
      } catch (e: any) {
        console.warn(`[competitors] poll failed for ${c.id}:`, e.message)
        fail++
      }
    }
    console.log(`[competitors] poll done — ok:${ok} fail:${fail}`)
  }
}
