import { Injectable, HttpException, OnModuleInit, Logger, BadRequestException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { ScraperService } from '../scraper/scraper.service'

const ML_BASE = 'https://api.mercadolibre.com'

export function normalizeMercadoLivreUrl(inputUrl: string | null | undefined): {
  itemId: string
  cleanUrl: string
  catalogId: string | null
} | null {
  if (!inputUrl) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(inputUrl.trim())
  } catch {
    decoded = inputUrl.trim()
  }

  let itemId: string | null = null
  let catalogId: string | null = null

  // 1. item_id via query (catálogo/PDP — pdp_filters=item_id:MLB...)
  const queryMatch = decoded.match(/item_id[=:]?(MLB\d+)/i)
  if (queryMatch) itemId = queryMatch[1].toUpperCase()

  // 2. wid=MLB... (catalog URL apontando pra listing específico do vendedor).
  // Tem prioridade sobre directMatch porque /p/MLBxxx no path é o catalog
  // product ID, não o listing — só wid identifica o vendedor concreto.
  if (!itemId) {
    const widMatch = decoded.match(/[?&]wid=(MLB\d+)/i)
    if (widMatch) itemId = widMatch[1].toUpperCase()
  }

  // 3. MLB direto na URL (com ou sem hífen) — não captura MLBU/MLBA/etc.
  // Strip /p/MLBxxx antes do match: catalog product ID não é listing válido
  // pra ML API /items/ (sempre devolve 404). Sem wid + sem item_id +
  // apenas /p/MLB → URL é só catálogo, sem listing específico → null.
  if (!itemId) {
    const stripped = decoded.replace(/\/p\/MLB-?\d+/gi, '')
    const directMatch = stripped.match(/MLB-?(\d+)/)
    if (directMatch) itemId = `MLB${directMatch[1]}`
  }

  // 4. catalog_id (URLs /up/MLBU…)
  const catalogMatch = decoded.match(/\/up\/(MLBU\d+)/i)
  if (catalogMatch) catalogId = catalogMatch[1].toUpperCase()

  if (!itemId) return null

  const numericId = itemId.replace(/^MLB/i, '')
  return {
    itemId,
    cleanUrl: `https://produto.mercadolivre.com.br/MLB-${numericId}`,
    catalogId,
  }
}

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

  constructor(
    private readonly mlService: MercadolivreService,
    private readonly scraper:   ScraperService,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  onModuleInit() {
    setTimeout(async () => {
      await this.updateExistingListingIds()
      const { data: orgs } = await supabaseAdmin.from('organizations').select('id')
      for (const org of orgs ?? []) {
        await this.enrichAllCompetitors(org.id)
      }
    }, 5000)
  }

  // ── Listing ID backfill ──────────────────────────────────────────────────────

  async updateExistingListingIds() {
    const { data, error } = await supabaseAdmin
      .from('competitors')
      .select('id, url, listing_id')
      .not('url', 'is', null)

    if (error) {
      this.logger.warn(`updateExistingListingIds query failed: ${error.message}`)
      return
    }

    let updated = 0
    for (const row of data ?? []) {
      const norm = normalizeMercadoLivreUrl(row.url as string)
      if (!norm) continue
      if (norm.itemId === row.listing_id) continue

      const { error: updErr } = await supabaseAdmin
        .from('competitors')
        .update({ listing_id: norm.itemId, url: norm.cleanUrl })
        .eq('id', row.id)

      if (updErr) {
        this.logger.warn(`failed to update listing_id id=${row.id}: ${updErr.message}`)
      } else {
        updated++
      }
    }

    if (updated > 0) {
      this.logger.log(`updateExistingListingIds: ${updated} de ${data?.length ?? 0} corrigidos`)
    }
  }

  // ── Core CRUD ─────────────────────────────────────────────────────────────────

  async create(orgId: string, dto: CreateCompetitorDto) {
    const norm =
      normalizeMercadoLivreUrl(dto.url) ??
      normalizeMercadoLivreUrl(dto.listing_id ?? '')
    const listingId = norm?.itemId ?? dto.listing_id ?? null
    const url = norm?.cleanUrl ?? dto.url

    const { data: competitor, error } = await supabaseAdmin
      .from('competitors')
      .insert({
        organization_id: orgId,
        product_id:      dto.product_id,
        platform:        dto.platform,
        url,
        listing_id:      listingId,
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

    // Normalize URL → resolve canonical listing_id
    const norm = normalizeMercadoLivreUrl(competitor.url as string | null)
    const listingId = norm?.itemId ?? (competitor.listing_id as string | null)

    if (norm && (norm.itemId !== competitor.listing_id || norm.cleanUrl !== competitor.url)) {
      await supabaseAdmin
        .from('competitors')
        .update({ listing_id: norm.itemId, url: norm.cleanUrl })
        .eq('id', competitorId)
    }

    if (!listingId) return null

    // Token OAuth do banco (refresha se expirado)
    let token: string
    try {
      const { token: t } = await this.mlService.getValidToken()
      token = t
    } catch (e: unknown) {
      this.logger.error(`[enrichCompetitor] sem token ML válido: ${(e as Error).message} — skip`)
      return null
    }

    let item: Record<string, unknown>
    try {
      item = await this.enrichFromML(listingId, token)
    } catch (e: unknown) {
      const status = (e as HttpException).getStatus?.() ?? 0
      if (status === 403) {
        // ML API bloqueia /items/ de listings de OUTROS sellers desde política
        // PolicyAgent (2024+). Fallback: scraping HTML via ScraperService
        // (User-Agent browser) — perde visits_30d/rating/reviews_total mas
        // mantém price/title/seller/qty/thumbnail/free_shipping.
        this.logger.warn(`[enrichCompetitor] 403 ML API listing=${listingId} — fallback HTML scraper`)
        try {
          const cleanUrl = `https://produto.mercadolivre.com.br/MLB-${listingId.replace(/^MLB/i, '')}`
          const scraped = await this.scraper.scrapeMercadoLivre(cleanUrl)
          if (!scraped || !scraped.price) {
            this.logger.warn(`[enrichCompetitor] scraper também falhou listing=${listingId}`)
            return null
          }
          // Monta item compatível com o shape do enrichFromML — campos
          // ausentes no scraper (rating, visits_30d, reviews_total) viram
          // undefined e o UPDATE abaixo não os toca via .eq existente.
          item = {
            price:              scraped.price,
            title:              scraped.title ?? undefined,
            thumbnail:          scraped.thumbnail ?? undefined,
            available_quantity: scraped.available_quantity ?? undefined,
            sold_quantity:      scraped.sold_quantity ?? undefined,
            seller:             { nickname: scraped.seller ?? undefined },
            shipping:           { free_shipping: scraped.free_shipping ?? undefined },
          }
        } catch (scrapeErr: unknown) {
          this.logger.error(`[enrichCompetitor] scraper exception listing=${listingId}: ${(scrapeErr as Error).message}`)
          return null
        }
      } else if (status === 404) {
        await supabaseAdmin.from('competitors').update({ status: 'inaccessible' }).eq('id', competitorId)
        return null
      } else {
        this.logger.error(`[enrichCompetitor] ML fetch falhou ${status} listing_id=${listingId}: ${(e as Error).message}`)
        return null
      }
    }

    const price    = (item.price as number) ?? 0
    const qty      = (item.available_quantity as number) ?? 0
    const sold     = (item.sold_quantity as number) ?? 0
    const seller   = (item as { seller?: { nickname?: string } }).seller
    const shipping = (item as { shipping?: { free_shipping?: boolean } }).shipping

    // Update competitor record
    await supabaseAdmin
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

    // Save to price_history with new columns
    const now = new Date().toISOString()
    await supabaseAdmin
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

    if (!competitors?.length) return
    let enriched = 0

    for (const c of competitors) {
      const r = await this.enrichCompetitor(c.id)
      if (r) enriched++
      await new Promise(r => setTimeout(r, 500))
    }
    this.logger.log(`[competitors.enrich] org=${orgId} enriched=${enriched}/${competitors.length}`)
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

    const listingId = normalizeMercadoLivreUrl(row.url as string | null)?.itemId ?? null

    let token: string | undefined
    try {
      const conn = await this.mlService.getValidToken()
      token = conn.token
    } catch { /* fallback to public */ }

    let enriched: Record<string, unknown> = {}
    if (listingId) {
      try {
        enriched = await this.enrichFromML(listingId, token)
      } catch (e: unknown) {
        const status = (e as HttpException).getStatus?.() ?? 0
        if (status === 403) {
          // Mesmo fallback do enrichCompetitor: ML PolicyAgent bloqueia listings
          // de outros sellers via API → cai pra HTML scraper. Mantém o flow
          // de UPDATE + saveSnapshot funcionando.
          this.logger.warn(`[refresh] 403 ML API listing=${listingId} — fallback HTML scraper`)
          try {
            const cleanUrl = `https://produto.mercadolivre.com.br/MLB-${listingId.replace(/^MLB/i, '')}`
            const scraped = await this.scraper.scrapeMercadoLivre(cleanUrl)
            if (!scraped || !scraped.price) {
              throw new HttpException(`Item ${listingId} não acessível via API nem HTML scraper`, 502)
            }
            enriched = {
              price:              scraped.price,
              title:              scraped.title ?? undefined,
              thumbnail:          scraped.thumbnail ?? undefined,
              available_quantity: scraped.available_quantity ?? undefined,
              sold_quantity:      scraped.sold_quantity ?? undefined,
              seller:             { nickname: scraped.seller ?? undefined },
              shipping:           { free_shipping: scraped.free_shipping ?? undefined },
            }
          } catch (scrapeErr: unknown) {
            if (scrapeErr instanceof HttpException) throw scrapeErr
            throw new HttpException(`Scraper exception: ${(scrapeErr as Error).message}`, 502)
          }
        } else if (status === 404) {
          await supabaseAdmin.from('competitors').update({ status: 'inaccessible' }).eq('id', id)
          throw e  // re-emite o 404 pro client com a mensagem original
        } else {
          throw e  // 5xx, timeout, etc — relança comportamento original
        }
      }
    }

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

  // ── Preview ML URL (used by /competitors/preview) ────────────────────────────

  async previewMlUrl(url: string) {
    const normalized = normalizeMercadoLivreUrl(url)
    if (!normalized) throw new BadRequestException('URL do Mercado Livre inválida')

    const { token } = await this.mlService.getValidToken()

    const { data } = await axios.get(
      `${ML_BASE}/items/${normalized.itemId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    )

    return {
      itemId:             normalized.itemId,
      cleanUrl:           normalized.cleanUrl,
      catalogId:          normalized.catalogId,
      title:              data?.title ?? null,
      price:              data?.price ?? null,
      thumbnail:          data?.thumbnail ?? null,
      available_quantity: data?.available_quantity ?? null,
      seller_nickname:    data?.seller?.nickname ?? null,
      status:             data?.status ?? null,
      platform:           'mercadolivre',
    }
  }

  // ── Scheduled enrichment every 2h ────────────────────────────────────────────

  @Cron('0 */2 * * *')
  async scheduledEnrichment() {
    const { data: orgs } = await supabaseAdmin.from('organizations').select('id')
    for (const org of orgs ?? []) {
      await this.enrichAllCompetitors(org.id)
    }
  }
}
