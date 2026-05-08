import { Controller, Get, Post, Query, Param, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MlQualityService } from './ml-quality.service'
import { MlQualitySyncService } from './ml-quality-sync.service'
import { MlLabelsService } from './ml-labels.service'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml-quality')
@UseGuards(SupabaseAuthGuard)
export class MlQualityController {
  constructor(
    private readonly svc:    MlQualityService,
    private readonly sync:   MlQualitySyncService,
    private readonly labels: MlLabelsService,
  ) {}

  // ── Dashboard ─────────────────────────────────────────────────

  @Get('dashboard')
  dashboard(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDashboard(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Listagem de items ─────────────────────────────────────────

  @Get('items')
  listItems(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')      sellerId?:      string,
    @Query('level')          level?:         string,
    @Query('domain_id')      domainId?:      string,
    @Query('penalty')        penalty?:       string,
    @Query('min_score')      minScore?:      string,
    @Query('max_score')      maxScore?:      string,
    @Query('listing_status') listingStatus?: string,
    @Query('catalog_only')   catalogOnly?:   string,
    @Query('q')              q?:             string,
    @Query('limit')          limit?:         string,
    @Query('offset')         offset?:        string,
    @Query('sort')           sort?:          string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listItems({
      orgId:         u.orgId,
      sellerId:      sellerId ? Number(sellerId) : undefined,
      level:         level as any,
      domainId,
      hasPenalty:    penalty === 'true' ? true : penalty === 'false' ? false : undefined,
      minScore:      minScore ? Number(minScore) : undefined,
      maxScore:      maxScore ? Number(maxScore) : undefined,
      listingStatus: listingStatus as any,
      catalogOnly:   catalogOnly === 'true',
      q,
      limit:         limit  ? Number(limit)  : 50,
      offset:        offset ? Number(offset) : 0,
      sort:          sort as any,
    })
  }

  @Get('items/:itemId')
  getItem(
    @ReqUser() u: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getItem(u.orgId, itemId, sellerId ? Number(sellerId) : undefined)
  }

  @Get('items/:itemId/history')
  getItemHistory(
    @ReqUser() u: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Query('seller_id') sellerId?: string,
    @Query('days')      days?:     string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getItemHistory(u.orgId, itemId, sellerId ? Number(sellerId) : undefined, days ? Number(days) : 90)
  }

  // ── Labels (traducoes PT-BR de domains/attributes) ────────────

  @Get('labels')
  getLabels(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.labels.getLabelsForOrg(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Categorias / domains ──────────────────────────────────────

  @Get('categories')
  categories(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCategories(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Visoes especiais ──────────────────────────────────────────

  @Get('quick-wins')
  quickWins(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getQuickWins(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 50)
  }

  @Get('penalties')
  penalties(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getPenalties(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 100)
  }

  // ── Sync (manual trigger) ─────────────────────────────────────

  @Post('sync')
  syncOrg(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.syncOrg(u.orgId, { sellerId: sellerId ? Number(sellerId) : undefined })
  }

  /** Enriquece snapshots com listing_status + catalog_listing
   *  (active/paused/closed/under_review). Fire-and-forget, retorna em <1s. */
  @Post('sync/enrich-listing-status')
  enrichListingStatus(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.enrichListingStatusAsync(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  @Get('sync/logs')
  syncLogs(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSyncLogs(u.orgId, limit ? Number(limit) : 20)
  }
}
