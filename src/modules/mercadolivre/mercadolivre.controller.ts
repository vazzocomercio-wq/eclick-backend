import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { MercadolivreService } from './mercadolivre.service'
import { MlBillingFetcherService } from './ml-billing-fetcher.service'
import { ScraperService } from '../scraper/scraper.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml')
@UseGuards(SupabaseAuthGuard)
export class MercadolivreController {
  constructor(
    private readonly ml: MercadolivreService,
    private readonly scraper: ScraperService,
    private readonly billingFetcher: MlBillingFetcherService,
  ) {}

  // POST /ml/orders/fetch-billing — manual trigger of the buyer-billing
  // batch. Body: { limit?: number }. Caps at 200 per request to keep
  // ML's 1 req/sec rate-limit from blowing past a 4-min HTTP timeout.
  // The /clientes button can be re-clicked to drain the queue.
  @Post('orders/fetch-billing')
  @HttpCode(HttpStatus.OK)
  async fetchBilling(@Body() body: { limit?: number }) {
    try {
      const limit = Math.min(Math.max(Number(body?.limit ?? 50), 1), 200)
      return await this.billingFetcher.fetchBatch(limit)
    } catch (e: unknown) {
      const err = e as { message?: string }
      return {
        processed: 0, with_cpf: 0, with_email: 0, with_phone: 0,
        no_data: 0, errors: 1, message: err?.message ?? 'erro',
      }
    }
  }

  // GET /ml/orders/billing-pending-count — # of orders still missing
  // buyer_billing_fetched_at. Drives the counter on the /clientes button.
  @Get('orders/billing-pending-count')
  async fetchBillingPendingCount() {
    try {
      const count = await this.billingFetcher.countPending()
      return { count }
    } catch {
      return { count: 0 }
    }
  }

  // POST /ml/orders/:order_id/refetch-billing — single-order re-fetch from
  // ML for the order detail card. Calls /orders/{id}/billing_info plus
  // /users/{buyer_id} for phone/email fallback. Returns the resolved buyer.
  @Post('orders/:order_id/refetch-billing')
  @HttpCode(HttpStatus.OK)
  async refetchOrderBilling(@Param('order_id') orderId: string) {
    try {
      return await this.billingFetcher.refetchOne(orderId)
    } catch (e: unknown) {
      const err = e as { message?: string }
      return { ok: false, order_id: orderId, buyer: null, message: err?.message ?? 'erro' }
    }
  }

  // GET /ml/competitors/preview?url=...
  @Get('competitors/preview')
  async previewCompetitor(@Query('url') url: string) {
    if (!url) throw new BadRequestException('url é obrigatório')
    return this.scraper.scrapeProduct(url)
  }

  // GET /ml/auth-url?redirect_uri=...
  @Get('auth-url')
  getAuthUrl(@Query('redirect_uri') redirectUri: string) {
    return { url: this.ml.getAuthUrl(redirectUri) }
  }

  // POST /ml/connect  { code, redirect_uri }
  @Post('connect')
  @HttpCode(HttpStatus.OK)
  connect(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { code: string; redirect_uri: string },
  ) {
    return this.ml.connect(user.orgId!, body.code, body.redirect_uri)
  }

  // DELETE /ml/disconnect?seller_id=123456  (omit to remove all)
  @Delete('disconnect')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.disconnect(user.orgId!, sellerId ? Number(sellerId) : undefined)
  }

  // GET /ml/status  (backward compat — first connection)
  @Get('status')
  status(@ReqUser() user: ReqUserPayload) {
    return this.ml.getConnection(user.orgId!)
  }

  // GET /ml/connections  (all connected accounts, no tokens)
  @Get('connections')
  getConnections(@ReqUser() user: ReqUserPayload) {
    return this.ml.getConnections(user.orgId!)
  }

  // GET /ml/item-info?url=...
  @Get('item-info')
  getItemInfo(
    @ReqUser() user: ReqUserPayload,
    @Query('url') url: string,
  ) {
    return this.ml.getItemInfo(user.orgId!, url)
  }

  // GET /ml/vinculos/preview?listing_id=MLB...
  @Get('vinculos/preview')
  getVinculoPreview(@Query('listing_id') listingId: string) {
    if (!listingId) throw new BadRequestException('listing_id é obrigatório')
    return this.ml.getListingPreview(listingId)
  }

  // GET /ml/items?offset=0&limit=50
  @Get('items')
  getItems(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ml.getItems(user.orgId!, Number(offset ?? 0), Number(limit ?? 50))
  }

  // POST /ml/items/import  { ml_item_id }
  @Post('items/import')
  @HttpCode(HttpStatus.OK)
  importItem(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { ml_item_id: string },
  ) {
    return this.ml.importItem(user.orgId!, body.ml_item_id)
  }

  // GET /ml/orders?offset=0&limit=50
  @Get('orders')
  getOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ml.getOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 50))
  }

  // GET /ml/metrics
  @Get('metrics')
  getMetrics(@ReqUser() user: ReqUserPayload) {
    return this.ml.getMetrics(user.orgId!)
  }

  // ── Pipeline endpoints ────────────────────────────────────────────────────

  // GET /ml/my-items
  @Get('my-items')
  getMyItems(@ReqUser() user: ReqUserPayload) {
    return this.ml.getMyItems(user.orgId!)
  }

  // GET /ml/categories/:id  — proxies ML API, no seller token needed
  @Get('categories/:id')
  getCategory(@Param('id') id: string) {
    return this.ml.getCategory(id)
  }

  // GET /ml/items/:mlbId
  @Get('items/:mlbId')
  getItemDetail(
    @ReqUser() user: ReqUserPayload,
    @Param('mlbId') mlbId: string,
  ) {
    return this.ml.getItemDetail(user.orgId!, mlbId)
  }

  // GET /ml/items/:mlbId/visits
  @Get('items/:mlbId/visits')
  getItemVisits(
    @ReqUser() user: ReqUserPayload,
    @Param('mlbId') mlbId: string,
  ) {
    return this.ml.getItemVisits(user.orgId!, mlbId)
  }

  // GET /ml/recent-orders?offset=0&limit=50&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
  @Get('recent-orders')
  getRecentOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset')    offset?:   string,
    @Query('limit')     limit?:    string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to')   dateTo?:   string,
  ) {
    return this.ml.getRecentOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 50), dateFrom, dateTo)
  }

  // GET /ml/catalog-competitors/:catalogId
  @Get('catalog-competitors/:catalogId')
  getCatalogCompetitors(
    @ReqUser() user: ReqUserPayload,
    @Param('catalogId') catalogId: string,
  ) {
    return this.ml.getCatalogCompetitors(user.orgId!, catalogId)
  }

  // GET /ml/seller-info
  @Get('seller-info')
  getSellerInfo(@ReqUser() user: ReqUserPayload) {
    return this.ml.getSellerInfo(user.orgId!)
  }

  // GET /ml/reputation
  @Get('reputation')
  getReputation(@ReqUser() user: ReqUserPayload) {
    return this.ml.getReputation(user.orgId!)
  }

  // GET /ml/questions?status=UNANSWERED
  // Always responds 200 — frontend (sidebar badges, etc.) polls this and
  // can't tolerate 500s. Real errors are logged server-side.
  @Get('questions')
  async getQuestions(
    @ReqUser() user: ReqUserPayload,
    @Query('status') status?: string,
  ) {
    try {
      return await this.ml.getQuestions(user.orgId!, status?.toUpperCase() ?? 'UNANSWERED')
    } catch (e: unknown) {
      const err = e as { message?: string }
      console.error('[ml.questions] erro:', err?.message)
      return { questions: [], total: 0, sellerId: null }
    }
  }

  // POST /ml/questions/:id/answer  { text: string }
  @Post('questions/:id/answer')
  @HttpCode(HttpStatus.OK)
  answerQuestion(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { text: string },
  ) {
    if (!body.text?.trim()) throw new BadRequestException('text é obrigatório')
    return this.ml.answerQuestion(user.orgId!, Number(id), body.text)
  }

  // GET /ml/claims — always 200, see comment on /questions above.
  @Get('claims')
  async getClaims(@ReqUser() user: ReqUserPayload) {
    try {
      return await this.ml.getClaims(user.orgId!)
    } catch (e: unknown) {
      const err = e as { message?: string }
      console.error('[ml.claims] erro:', err?.message)
      return { data: [], total: 0 }
    }
  }

  // ── Catalog / Listings ────────────────────────────────────────────────────

  // GET /ml/orders/kpis
  @Get('orders/kpis')
  getOrdersKpis(@ReqUser() user: ReqUserPayload) {
    return this.ml.getOrdersKpis(user.orgId!)
  }

  // GET /ml/orders/enriched?offset=0&limit=20&q=...
  @Get('orders/enriched')
  getOrdersEnriched(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit')  limit?: string,
    @Query('q')      q?: string,
  ) {
    return this.ml.getOrdersEnriched(user.orgId!, Number(offset ?? 0), Number(limit ?? 20), q)
  }

  // GET /ml/listings/visits
  @Get('listings/visits')
  getListingsVisits(@ReqUser() user: ReqUserPayload) {
    return this.ml.getListingsVisits(user.orgId!)
  }

  // GET /ml/listings/counts
  @Get('listings/counts')
  getListingsCounts(@ReqUser() user: ReqUserPayload) {
    return this.ml.getListingsCounts(user.orgId!)
  }

  // POST /ml/products/from-listing  { listing_ids: string[] }
  @Post('products/from-listing')
  @HttpCode(HttpStatus.OK)
  async createFromListing(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { listing_ids?: string[] },
  ) {
    const ids = body.listing_ids ?? []
    if (!ids.length) throw new BadRequestException('listing_ids é obrigatório')
    if (ids.length > 20) throw new BadRequestException('Máximo 20 anúncios por vez')
    return this.ml.createFromListing(user.orgId, ids)
  }

  // GET /ml/financial-summary?date_from=...&date_to=...&status=...&kpis_only=true&totals_only=true
  @Get('financial-summary')
  getFinancialSummary(
    @ReqUser() user: ReqUserPayload,
    @Query('date_from')    dateFrom?: string,
    @Query('date_to')      dateTo?: string,
    @Query('status')       status?: string,
    @Query('kpis_only')    kpisOnly?: string,
    @Query('totals_only')  totalsOnly?: string,
  ) {
    const now  = new Date()
    const from = dateFrom ?? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const to   = dateTo   ?? now.toISOString()
    if (totalsOnly === 'true') {
      return this.ml.getOrderTotals(user.orgId!, from, to)
    }
    return this.ml.getFinancialSummary(
      user.orgId!,
      from,
      to,
      status,
      kpisOnly === 'true',
    )
  }

  // GET /ml/listings?status=active&limit=20&offset=0&q=busca
  @Get('listings')
  getListings(
    @ReqUser() user: ReqUserPayload,
    @Query('status') status?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ) {
    return this.ml.getListings(user.orgId!, status ?? 'active', Number(offset ?? 0), Number(limit ?? 20), q)
  }
}
