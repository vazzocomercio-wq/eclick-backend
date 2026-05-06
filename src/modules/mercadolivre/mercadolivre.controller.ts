import {
  Controller,
  Get,
  Post,
  Patch,
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
import { OrderDetailService } from './order-detail.service'
import { MlQuestionsAiService, TransformAction } from './ml-questions-ai.service'
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
    private readonly orderDetail: OrderDetailService,
    private readonly questionsAi: MlQuestionsAiService,
  ) {}

  /** GET /ml/orders/:external_order_id/full-detail — agregador read-only
   * pra widget de detalhe em /dashboard/pedidos. Retorna order + customer
   * unificado (por CPF) + comunicação (OCJ + sends). 404 só se order não
   * existe; customer/communication podem vir null. Org-scoped. */
  @Get('orders/:external_order_id/full-detail')
  fullDetail(
    @ReqUser() user: ReqUserPayload,
    @Param('external_order_id') externalOrderId: string,
  ) {
    return this.orderDetail.getFullDetail(user.orgId ?? '', externalOrderId)
  }

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

  // GET /ml/orders/orphans-count — # of orders that were marked tried but
  // ended up with NULL doc_number (e.g. parsed by an older shape).
  // Drives the "Resetar pedidos sem CPF" counter in /clientes.
  @Get('orders/orphans-count')
  async fetchOrphansCount() {
    try {
      const count = await this.billingFetcher.countOrphans()
      return { count }
    } catch {
      return { count: 0 }
    }
  }

  // POST /ml/orders/bulk-mark-problem
  //   { order_ids: (string|number)[], note: string,
  //     severity: 'low'|'medium'|'high'|'critical' }
  // Marca um lote de pedidos como tendo problema. has_problem=true,
  // problem_note + problem_severity em colunas separadas (CHECK
  // constraint no DB). Match por external_order_id.
  @Post('orders/bulk-mark-problem')
  @HttpCode(HttpStatus.OK)
  async bulkMarkProblem(@Body() body: {
    order_ids: Array<string | number>
    note:      string
    severity?: 'low' | 'medium' | 'high' | 'critical'
  }) {
    const ids  = (body?.order_ids ?? []).map(x => String(x)).filter(Boolean)
    const note = (body?.note ?? '').trim()
    const allowed = ['low', 'medium', 'high', 'critical'] as const
    const sev = (allowed as readonly string[]).includes(body?.severity ?? '')
      ? body!.severity!
      : 'medium'
    if (ids.length === 0)  throw new BadRequestException('order_ids vazio')
    if (!note)             throw new BadRequestException('note obrigatório')
    return this.ml.bulkMarkProblem(ids, note, sev)
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

  // POST /ml/orders/:order_id/debug-billing — diagnostic. Runs the 3 ML
  // calls (GET /orders/{id}, NEW billing-info/MLB/{id}, LEGACY
  // /orders/{id}/billing_info) plus /users/{buyer_id} and returns the full
  // structured log so we can see WHY billing_info.id isn't being captured.
  // Read-only — does NOT touch the orders table.
  @Post('orders/:order_id/debug-billing')
  @HttpCode(HttpStatus.OK)
  async debugOrderBilling(@Param('order_id') orderId: string) {
    try {
      return await this.billingFetcher.debugBilling(orderId)
    } catch (e: unknown) {
      const err = e as { message?: string }
      return { order_id: orderId, log: [{ step: 'unhandled', message: err?.message ?? 'erro' }] }
    }
  }

  // POST /ml/orders/reset-billing-fetched — zeros buyer_billing_fetched_at
  // on rows that were marked tried but ended up with NULL doc_number, so
  // the next cron tick re-processes them with the current parser.
  // Body: { force_all?: boolean } — default false (only resets rows
  // missing CPF; never undoes successful refetches).
  @Post('orders/reset-billing-fetched')
  @HttpCode(HttpStatus.OK)
  async resetBillingFetched(@Body() body: { force_all?: boolean } = {}) {
    try {
      return await this.billingFetcher.resetBillingFetched({ forceAll: body?.force_all === true })
    } catch (e: unknown) {
      const err = e as { message?: string }
      return { reset: 0, message: err?.message ?? 'erro' }
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

  // GET /ml/orders?offset=0&limit=50&seller_id=...
  @Get('orders')
  getOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getOrders(
      user.orgId!,
      Number(offset ?? 0),
      Number(limit ?? 50),
      sellerId ? Number(sellerId) : undefined,
    )
  }

  // GET /ml/metrics?seller_id=...
  @Get('metrics')
  getMetrics(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getMetrics(user.orgId!, sellerId ? Number(sellerId) : undefined)
  }

  // ── Pipeline endpoints ────────────────────────────────────────────────────

  // GET /ml/my-items
  // GET /ml/my-items?seller_id=...
  @Get('my-items')
  getMyItems(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getMyItems(user.orgId!, sellerId ? Number(sellerId) : undefined)
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

  // GET /ml/recent-orders?offset=0&limit=50&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&seller_id=...
  @Get('recent-orders')
  getRecentOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset')    offset?:   string,
    @Query('limit')     limit?:    string,
    @Query('date_from') dateFrom?: string,
    @Query('date_to')   dateTo?:   string,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getRecentOrders(
      user.orgId!,
      Number(offset ?? 0),
      Number(limit ?? 50),
      dateFrom,
      dateTo,
      sellerId ? Number(sellerId) : undefined,
    )
  }

  // GET /ml/catalog-competitors/:catalogId
  @Get('catalog-competitors/:catalogId')
  getCatalogCompetitors(
    @ReqUser() user: ReqUserPayload,
    @Param('catalogId') catalogId: string,
  ) {
    return this.ml.getCatalogCompetitors(user.orgId!, catalogId)
  }

  // GET /ml/seller-info?seller_id=...
  @Get('seller-info')
  getSellerInfo(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getSellerInfo(user.orgId!, sellerId ? Number(sellerId) : undefined)
  }

  // GET /ml/reputation?seller_id=...
  @Get('reputation')
  getReputation(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getReputation(user.orgId!, sellerId ? Number(sellerId) : undefined)
  }

  // GET /ml/questions?status=UNANSWERED
  // Always responds 200 — frontend (sidebar badges, etc.) polls this and
  // can't tolerate 500s. Real errors are logged server-side.
  @Get('questions')
  async getQuestions(
    @ReqUser() user: ReqUserPayload,
    @Query('status') status?: string,
    @Query('seller_id') sellerIdParam?: string,
  ) {
    try {
      const sellerId = sellerIdParam ? Number(sellerIdParam) : undefined
      return await this.ml.getQuestions(user.orgId!, status?.toUpperCase() ?? 'UNANSWERED', sellerId)
    } catch (e: unknown) {
      const err = e as { message?: string }
      console.error('[ml.questions] erro:', err?.message)
      return { questions: [], total: 0, sellerId: null }
    }
  }

  // ── Sprint ML Questions AI ──────────────────────────────────────────────
  // Rotas estáticas vêm ANTES de :id pra NestJS resolver corretamente.

  // POST /ml/questions/transform-text  { text, action }
  @Post('questions/transform-text')
  @HttpCode(HttpStatus.OK)
  transformText(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { text: string; action: TransformAction },
  ) {
    return this.questionsAi.transformText(user.orgId!, body.text, body.action)
  }

  // POST /ml/questions/poll — manual trigger do cron de sugestões pra esta org.
  @Post('questions/poll')
  @HttpCode(HttpStatus.OK)
  pollQuestions(@ReqUser() user: ReqUserPayload) {
    return this.questionsAi.pollAndSuggest(user.orgId!)
  }

  // GET /ml/questions/ai-stats — métricas dos últimos 30 dias (Aprovação IA)
  // + contagem de auto-respostas das últimas 24h.
  @Get('questions/ai-stats')
  getAiStats(@ReqUser() user: ReqUserPayload) {
    return this.questionsAi.getAiStats(user.orgId!)
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

  // POST /ml/questions/:id/suggest-answer
  @Post('questions/:id/suggest-answer')
  @HttpCode(HttpStatus.OK)
  suggestAnswer(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    return this.questionsAi.suggestAnswer(user.orgId!, id)
  }

  // POST /ml/questions/:id/approve-and-send  { finalAnswer, wasEdited }
  @Post('questions/:id/approve-and-send')
  @HttpCode(HttpStatus.OK)
  approveAndSend(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { finalAnswer: string; wasEdited: boolean },
  ) {
    return this.questionsAi.approveAndSend(user.orgId!, id, body.finalAnswer, body.wasEdited === true)
  }

  // GET /ml/settings/auto-answer
  @Get('settings/auto-answer')
  async getAutoAnswerSetting(@ReqUser() user: ReqUserPayload) {
    const enabled = await this.questionsAi.getAutoSendEnabled(user.orgId!)
    return { enabled }
  }

  // PATCH /ml/settings/auto-answer  { enabled: boolean }
  @Patch('settings/auto-answer')
  @HttpCode(HttpStatus.OK)
  setAutoAnswerSetting(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { enabled: boolean },
  ) {
    return this.questionsAi.setAutoSendEnabled(user.orgId!, body.enabled === true)
  }

  // GET /ml/claims?seller_id=... — always 200, see comment on /questions above.
  @Get('claims')
  async getClaims(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    try {
      return await this.ml.getClaims(user.orgId!, sellerId ? Number(sellerId) : undefined)
    } catch (e: unknown) {
      const err = e as { message?: string }
      console.error('[ml.claims] erro:', err?.message)
      return { data: [], total: 0 }
    }
  }

  // ── Catalog / Listings ────────────────────────────────────────────────────

  // GET /ml/orders/kpis?seller_id=...
  @Get('orders/kpis')
  getOrdersKpis(
    @ReqUser() user: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getOrdersKpis(user.orgId!, sellerId ? Number(sellerId) : undefined)
  }

  // GET /ml/orders/enriched?offset=0&limit=20&q=...&seller_id=...
  @Get('orders/enriched')
  getOrdersEnriched(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit')  limit?: string,
    @Query('q')      q?: string,
    @Query('seller_id') sellerId?: string,
  ) {
    return this.ml.getOrdersEnriched(
      user.orgId!,
      Number(offset ?? 0),
      Number(limit ?? 20),
      q,
      sellerId ? Number(sellerId) : undefined,
    )
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

  // POST /ml/products/from-listing  { listing_ids: string[]; seller_id?: number }
  @Post('products/from-listing')
  @HttpCode(HttpStatus.OK)
  async createFromListing(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { listing_ids?: string[]; seller_id?: number | string },
  ) {
    const ids = body.listing_ids ?? []
    if (!ids.length) throw new BadRequestException('listing_ids é obrigatório')
    if (ids.length > 20) throw new BadRequestException('Máximo 20 anúncios por vez')
    const sellerId = body.seller_id != null ? Number(body.seller_id) : undefined
    return this.ml.createFromListing(user.orgId, ids, sellerId)
  }

  // GET /ml/financial-summary?date_from=...&date_to=...&status=...&kpis_only=true&totals_only=true&seller_id=...
  @Get('financial-summary')
  getFinancialSummary(
    @ReqUser() user: ReqUserPayload,
    @Query('date_from')    dateFrom?: string,
    @Query('date_to')      dateTo?: string,
    @Query('status')       status?: string,
    @Query('kpis_only')    kpisOnly?: string,
    @Query('totals_only')  totalsOnly?: string,
    @Query('seller_id')    sellerId?: string,
  ) {
    const now  = new Date()
    const from = dateFrom ?? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const to   = dateTo   ?? now.toISOString()
    const sellerIdNum = sellerId ? Number(sellerId) : undefined
    if (totalsOnly === 'true') {
      return this.ml.getOrderTotals(user.orgId!, from, to, sellerIdNum)
    }
    return this.ml.getFinancialSummary(
      user.orgId!,
      from,
      to,
      status,
      kpisOnly === 'true',
      sellerIdNum,
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
