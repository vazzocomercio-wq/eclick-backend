import { Injectable, HttpException, OnModuleInit, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

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
export class CompetitorsService implements OnModuleInit {
  private readonly logger = new Logger(CompetitorsService.name)

  constructor(private readonly mlService: MercadolivreService) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onModuleInit() {
    setTimeout(async () => {
      this.logger.log('iniciando enriquecimento inicial...')
      const { data: orgs } = await supabaseAdmin.from('organizations').select('id')
      for (const org of orgs ?? []) {
        await this.enrichAllCompetitors(org.id)
      }
    }, 5000)
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────────

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
      throw new HttpException(error?.message ?? 'Erro ao criar concorrente', 400)
    }

    try {
      await supabaseAdmin
        .from('price_history')
        .insert({
          competitor_id: competitor.id,
          price: dto.current_price,
          recorded_at: new Date().toISOString(),
        })
    } catch (e: unknown) {
      this.logger.warn('price_history insert failed: ' + (e instanceof Error ? e.message : e))
    }

    return competitor
  }

  async list(orgId: string, productId?: string) {
    let q = supabaseAdmin
      .from('competitors')
      .select('id, product_id, platform, url, listing_id, title, seller, current_price, my_price, photo_url, status, last_checked, enriched_at, created_at')
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

  // ── Detail & History ──────────────────────────────────────────────────────────

  async getOne(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('competitors')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .single()

    if (error || !data) throw new HttpException('Concorrente não encontrado', 404)

    const { data: history } = await supabaseAdmin
      .from('price_history')
      .select('price, my_price, available_quantity, sold_quantity, recorded_at, checked_at')
      .eq('competitor_id', id)
      .order('recorded_at', { ascending: false })
      .limit(180)

    return { ...data, price_history: history ?? [] }
  }

  async getHistory(id: string) {
    const { data, error } = await supabaseAdmin
      .from('price_history')
      .select('id, price, my_price, available_quantity, sold_quantity, recorded_at, checked_at')
      .eq('competitor_id', id)
      .order('recorded_at', { ascending: false })
      .limit(360)

    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  // ── ML Enrichment ─────────────────────────────────────────────────────────────

  async enrichFromML(listingId: string, token?: string): Promise<Record<string, unknown>> {
    const attrs = 'id,title,price,available_quantity,sold_quantity,thumbnail,pictures,seller,shipping,listing_type_id,permalink,category_id,date_created,last_updated,health,attributes'
    const headers = token ? { Authorization: `Bearer ${token}` } : {}

    const [itemRes, visitsRes, descRes, reviewsRes] = await Promise.allSettled([
      axios.get(`${ML_BASE}/items/${listingId}`, { params: { attributes: attrs }, headers }),
      axios.get(`${ML_BASE}/items/${listingId}/visits`, { params: { last: 30 }, headers }),
      axios.get(`${ML_BASE}/items/${listingId}/description`, { headers }),
      axios.get(`${ML_BASE}/reviews/item/${listingId}`, { headers }),
    ])

    if (itemRes.status === 'rejected') {
      const status = (itemRes.reason as AxiosError)?.response?.status ?? 500
      throw new HttpException(`Item ${listingId} não encontrado na ML`, status)
    }

    const item    = itemRes.value.data
    const visits  = visitsRes.status  === 'fulfilled' ? visitsRes.value.data  : {}
    const desc    = descRes.status    === 'fulfilled' ? descRes.value.data    : {}
    const reviews = reviewsRes.status === 'fulfilled' ? reviewsRes.value.data : {}

    return {
      ...item,
      visits_30d:    visits?.total_visits    ?? 0,
      description:   desc?.plain_text        ?? '',
      rating:        reviews?.rating_average ?? 0,
      reviews_total: reviews?.total          ?? 0,
      enriched_at:   new Date().toISOString(),
    }
  }

  // ── Enrich single competitor ──────────────────────────────────────────────────

  async enrichCompetitor(competitorId: string) {
    const { data: competitor, error: fetchErr } = await supabaseAdmin
      .from('competitors')
      .select('*')
      .eq('id', competitorId)
      .single()

    if (fetchErr || !competitor) {
      this.logger.error(`[enrichCompetitor] fetch failed id=${competitorId}: ${fetchErr?.message}`)
      return null
    }

    // Extract listing_id from URL if missing
    let listingId = competitor.listing_id as string | null
    if (!listingId && competitor.url) {
      const m = (competitor.url as string).match(/MLB[0-9]+/i)
      if (m) {
        listingId = m[0].toUpperCase()
        const { error: lidErr } = await supabaseAdmin
          .from('competitors')
          .update({ listing_id: listingId })
          .eq('id', competitorId)
        this.logger.log(`[enrichCompetitor] extracted listing_id=${listingId} from URL | update: ${lidErr?.message ?? 'ok'}`)
      }
    }

    if (!listingId) {
      this.logger.warn(`[enrichCompetitor] id=${competitorId} sem listing_id e URL não contém MLB — skip`)
      return null
    }

    this.logger.log(`[enrichCompetitor] iniciando enrich para listing_id=${listingId}`)

    // Get valid token (auto-refreshes if expired)
    let token: string | undefined
    try {
      const conn = await this.mlService.getTokenForOrg(competitor.organization_id)
      token = conn.token
      this.logger.log(`[enrichCompetitor] token obtido para org=${competitor.organization_id} seller=${conn.sellerId}`)
    } catch (e: unknown) {
      this.logger.warn(`[enrichCompetitor] falhou ao obter token: ${(e as Error).message} — tentando sem auth`)
    }

    let item: Record<string, unknown>
    try {
      item = await this.enrichFromML(listingId, token)
      this.logger.log(`[enrichCompetitor] ML retornou id=${item.id} price=${item.price}`)
    } catch (e: unknown) {
      const status = (e as HttpException).getStatus?.() ?? 0
      if (status === 403 || status === 401) {
        // Retry without token (some items accessible publicly)
        if (token) {
          this.logger.warn(`[enrichCompetitor] ${status} com token — retentando sem auth`)
          try {
            item = await this.enrichFromML(listingId, undefined)
            this.logger.log(`[enrichCompetitor] ML (sem auth) retornou id=${item.id} price=${item.price}`)
          } catch (e2: unknown) {
            const s2 = (e2 as HttpException).getStatus?.() ?? 0
            if (s2 === 403) {
              this.logger.warn(`[enrichCompetitor] 403 sem auth também — marcando inaccessible listing_id=${listingId}`)
              await supabaseAdmin.from('competitors').update({ status: 'inaccessible' }).eq('id', competitorId)
            } else {
              this.logger.error(`[enrichCompetitor] sem auth falhou ${s2} listing_id=${listingId}: ${(e2 as Error).message}`)
            }
            return null
          }
        } else {
          this.logger.warn(`[enrichCompetitor] 403 sem token — marcando inaccessible listing_id=${listingId}`)
          await supabaseAdmin.from('competitors').update({ status: 'inaccessible' }).eq('id', competitorId)
          return null
        }
      } else {
        this.logger.error(`[enrichCompetitor] ML fetch falhou listing_id=${listingId}: ${(e as Error).message}`)
        return null
      }
    }

    const price    = (item.price as number) ?? 0
    const qty      = (item.available_quantity as number) ?? 0
    const sold     = (item.sold_quantity as number) ?? 0
    const seller   = (item as { seller?: { nickname?: string } }).seller
    const shipping = (item as { shipping?: { free_shipping?: boolean } }).shipping

    // Update competitor record
    const { error: updateErr } = await supabaseAdmin
      .from('competitors')
      .update({
        current_price:      price,
        available_quantity: qty,
        sold_quantity:      sold,
        title:              (item.title as string) ?? undefined,
        photo_url:          (item.thumbnail as string) ?? undefined,
        seller:             seller?.nickname ?? undefined,
        seller_nickname:    seller?.nickname ?? undefined,
        seller_reputation:  (item as { seller?: { seller_reputation?: { level_id?: string } } }).seller?.seller_reputation?.level_id ?? undefined,
        rating:             (item.rating as number) ?? undefined,
        reviews_total:      (item.reviews_total as number) ?? undefined,
        visits_30d:         (item.visits_30d as number) ?? undefined,
        listing_type:       (item.listing_type_id as string) ?? undefined,
        free_shipping:      shipping?.free_shipping ?? undefined,
        enriched_at:        new Date().toISOString(),
        last_checked:       new Date().toISOString(),
      })
      .eq('id', competitorId)

    this.logger.log(`[enrichCompetitor] UPDATE competitors id=${competitorId}: ${updateErr?.message ?? 'ok'} | price=${price}`)

    // Save to price_history with new columns
    const now = new Date().toISOString()
    const { error: phErr } = await supabaseAdmin
      .from('price_history')
      .insert({
        competitor_id:      competitorId,
        organization_id:    competitor.organization_id,
        product_id:         competitor.product_id,
        price,
        my_price:           competitor.my_price,
        available_quantity: qty,
        sold_quantity:      sold,
        recorded_at:        now,
        checked_at:         now,
      })

    this.logger.log(`[enrichCompetitor] INSERT price_history: ${phErr?.message ?? 'ok'}`)

    // Alert if price diff > 10%
    const myPrice = Number(competitor.my_price)
    if (myPrice > 0 && price > 0) {
      const diff_pct = ((myPrice - price) / myPrice) * 100
      if (Math.abs(diff_pct) > 10) {
        await supabaseAdmin
          .from('competitor_alerts')
          .upsert({
            competitor_id:    competitorId,
            organization_id:  competitor.organization_id,
            product_id:       competitor.product_id,
            alert_type:       diff_pct > 0 ? 'price_above' : 'price_below',
            my_price:         myPrice,
            competitor_price: price,
            difference_pct:   diff_pct,
            created_at:       now,
          })
          .then(({ error }) => {
            if (error) this.logger.warn(`competitor_alerts upsert failed: ${error.message}`)
          })
      }
    }

    this.logger.log(`enriched ${listingId}: R$ ${price}`)
    return item
  }

  // ── Enrich all for an org ─────────────────────────────────────────────────────

  async enrichAllCompetitors(orgId: string) {
    const { data: competitors } = await supabaseAdmin
      .from('competitors')
      .select('id')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .not('url', 'is', null)

    this.logger.log(`enriching ${competitors?.length ?? 0} competitors for org ${orgId}`)

    for (const c of competitors ?? []) {
      await this.enrichCompetitor(c.id)
      await new Promise(r => setTimeout(r, 500))
    }
  }

  // ── Snapshot (legacy) ─────────────────────────────────────────────────────────

  async saveSnapshot(competitorId: string, price: number, availableQty: number, soldQty: number) {
    const { error } = await supabaseAdmin
      .from('price_history')
      .insert({
        competitor_id:      competitorId,
        price,
        available_quantity: availableQty,
        sold_quantity:      soldQty,
        recorded_at:        new Date().toISOString(),
        checked_at:         new Date().toISOString(),
      })
    if (error) this.logger.warn('snapshot insert failed: ' + error.message)
  }

  // ── Refresh single (legacy endpoint, preserves existing behavior) ─────────────

  async refresh(orgId: string, id: string) {
    const { data: row, error } = await supabaseAdmin
      .from('competitors')
      .select('id, url, platform, organization_id')
      .eq('id', id)
      .eq('organization_id', orgId)
      .single()

    if (error || !row) throw new HttpException('Concorrente não encontrado', 404)

    const mlbMatch = (row.url as string | null)?.match(/MLB[0-9]+/i)
    const listingId = mlbMatch ? mlbMatch[0].toUpperCase() : null

    let token: string | undefined
    try {
      const conn = await this.mlService.getTokenForOrg(row.organization_id as string)
      token = conn.token
    } catch { /* fallback to public */ }

    let enriched: Record<string, unknown> = {}
    if (listingId) enriched = await this.enrichFromML(listingId, token)

    const price  = (enriched.price as number) ?? 0
    const qty    = (enriched.available_quantity as number) ?? 0
    const sold   = (enriched.sold_quantity as number) ?? 0
    const seller = (enriched as { seller?: { nickname?: string } }).seller

    if (price > 0) {
      await supabaseAdmin.from('competitors').update({
        current_price:      price,
        available_quantity: qty,
        sold_quantity:      sold,
        title:              (enriched.title as string) ?? undefined,
        photo_url:          (enriched.thumbnail as string) ?? undefined,
        seller:             seller?.nickname ?? undefined,
        seller_nickname:    seller?.nickname ?? undefined,
        seller_reputation:  (enriched as { seller?: { seller_reputation?: { level_id?: string } } }).seller?.seller_reputation?.level_id ?? undefined,
        rating:             (enriched.rating as number) ?? undefined,
        reviews_total:      (enriched.reviews_total as number) ?? undefined,
        visits_30d:         (enriched.visits_30d as number) ?? undefined,
        listing_type:       (enriched.listing_type_id as string) ?? undefined,
        free_shipping:      (enriched as { shipping?: { free_shipping?: boolean } }).shipping?.free_shipping ?? undefined,
        enriched_at:        new Date().toISOString(),
        last_checked:       new Date().toISOString(),
      }).eq('id', id)

      await this.saveSnapshot(id, price, qty, sold)
    }

    const base = await this.getOne(orgId, id)
    return { ...base, ml_data: enriched }
  }

  // ── Scheduled enrichment every 2h ────────────────────────────────────────────

  @Cron('0 */2 * * *')
  async scheduledEnrichment() {
    this.logger.log('scheduled enrichment starting…')
    const { data: orgs } = await supabaseAdmin.from('organizations').select('id')
    for (const org of orgs ?? []) {
      await this.enrichAllCompetitors(org.id)
    }
  }
}
