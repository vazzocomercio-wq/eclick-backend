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
} from '@nestjs/common'
import { MercadolivreService } from './mercadolivre.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml')
@UseGuards(SupabaseAuthGuard)
export class MercadolivreController {
  constructor(private readonly ml: MercadolivreService) {}

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

  // GET /ml/recent-orders?offset=0&limit=50
  @Get('recent-orders')
  getRecentOrders(
    @ReqUser() user: ReqUserPayload,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ml.getRecentOrders(user.orgId!, Number(offset ?? 0), Number(limit ?? 50))
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

  // GET /ml/questions
  @Get('questions')
  getQuestions(@ReqUser() user: ReqUserPayload) {
    return this.ml.getQuestions(user.orgId!)
  }

  // GET /ml/claims
  @Get('claims')
  getClaims(@ReqUser() user: ReqUserPayload) {
    return this.ml.getClaims(user.orgId!)
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

  // GET /ml/financial-summary?date_from=...&date_to=...&status=...&kpis_only=true
  @Get('financial-summary')
  getFinancialSummary(
    @ReqUser() user: ReqUserPayload,
    @Query('date_from')  dateFrom?: string,
    @Query('date_to')    dateTo?: string,
    @Query('status')     status?: string,
    @Query('kpis_only')  kpisOnly?: string,
  ) {
    const now  = new Date()
    const from = dateFrom ?? new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const to   = dateTo   ?? now.toISOString()
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
