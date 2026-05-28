import { Controller, Get, Post, Query, Param, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MlQualityService } from './ml-quality.service'
import { MlQualitySyncService } from './ml-quality-sync.service'
import { MlLabelsService } from './ml-labels.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml-quality')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class MlQualityController {
  constructor(
    private readonly svc:    MlQualityService,
    private readonly sync:   MlQualitySyncService,
    private readonly labels: MlLabelsService,
  ) {}

  // ── Dashboard ─────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermission('products.view')
  dashboard(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDashboard(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Listagem de items ─────────────────────────────────────────

  @Get('items')
  @RequirePermission('products.view')
  listItems(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')       sellerId?:      string,
    @Query('level')           level?:         string,
    @Query('domain_id')       domainId?:      string,
    @Query('penalty')         penalty?:       string,
    @Query('min_score')       minScore?:      string,
    @Query('max_score')       maxScore?:      string,
    @Query('listing_status')  listingStatus?: string,
    @Query('catalog')         catalog?:       string,
    @Query('q')               q?:             string,
    @Query('limit')           limit?:         string,
    @Query('offset')          offset?:        string,
    @Query('sort')            sort?:          string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listItems({
      orgId:          u.orgId,
      sellerId:       sellerId ? Number(sellerId) : undefined,
      level:          level as any,
      domainId,
      hasPenalty:     penalty === 'true' ? true : penalty === 'false' ? false : undefined,
      minScore:       minScore ? Number(minScore) : undefined,
      maxScore:       maxScore ? Number(maxScore) : undefined,
      listingStatus:  listingStatus as any,
      catalogListing: catalog === 'true' ? true : catalog === 'false' ? false : undefined,
      q,
      limit:          limit  ? Number(limit)  : 50,
      offset:         offset ? Number(offset) : 0,
      sort:           sort as any,
    })
  }

  /** Fire-and-forget enriquecer listing_status nos snapshots existentes. */
  @Post('sync/enrich-listing-status')
  @RequirePermission('products.update')
  enrichListingStatus(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.enrichListingStatusAsync(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  @Get('items/:itemId')
  @RequirePermission('products.view')
  getItem(
    @ReqUser() u: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getItem(u.orgId, itemId, sellerId ? Number(sellerId) : undefined)
  }

  @Get('items/:itemId/history')
  @RequirePermission('products.view')
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
  @RequirePermission('products.view')
  getLabels(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.labels.getLabelsForOrg(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Categorias / domains ──────────────────────────────────────

  @Get('categories')
  @RequirePermission('products.view')
  categories(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCategories(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Visoes especiais ──────────────────────────────────────────

  @Get('quick-wins')
  @RequirePermission('products.view')
  quickWins(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getQuickWins(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 50)
  }

  @Get('penalties')
  @RequirePermission('products.view')
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
  @RequirePermission('products.update')
  syncOrg(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.syncOrg(u.orgId, { sellerId: sellerId ? Number(sellerId) : undefined })
  }

  @Get('sync/logs')
  @RequirePermission('products.view')
  syncLogs(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSyncLogs(u.orgId, limit ? Number(limit) : 20)
  }
}
