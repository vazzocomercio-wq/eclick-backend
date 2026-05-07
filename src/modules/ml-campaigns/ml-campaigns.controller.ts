import { Controller, Get, Post, Query, Param, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MlCampaignsService } from './ml-campaigns.service'
import { MlCampaignsSyncService } from './ml-campaigns-sync.service'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml-campaigns')
@UseGuards(SupabaseAuthGuard)
export class MlCampaignsController {
  constructor(
    private readonly svc:  MlCampaignsService,
    private readonly sync: MlCampaignsSyncService,
  ) {}

  // ── Dashboard ──────────────────────────────────────────────────

  @Get('dashboard')
  dashboard(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDashboard(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Campanhas ──────────────────────────────────────────────────

  @Get()
  listCampaigns(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')        sellerId?:     string,
    @Query('status')           status?:       string,
    @Query('type')             type?:         string,
    @Query('has_subsidy')      hasSubsidy?:   string,
    @Query('ending_in_days')   endingInDays?: string,
    @Query('limit')            limit?:        string,
    @Query('offset')           offset?:       string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listCampaigns({
      orgId:        u.orgId,
      sellerId:     sellerId ? Number(sellerId) : undefined,
      status:       status as any,
      type,
      hasSubsidy:   hasSubsidy === 'true' ? true : hasSubsidy === 'false' ? false : undefined,
      endingInDays: endingInDays ? Number(endingInDays) : undefined,
      limit:        limit  ? Number(limit)  : 100,
      offset:       offset ? Number(offset) : 0,
    })
  }

  @Get('deadlines')
  deadlines(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')  sellerId?: string,
    @Query('days_ahead') days?:     string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDeadlines(u.orgId, sellerId ? Number(sellerId) : undefined, days ? Number(days) : 7)
  }

  @Get('health')
  health(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getMissingDataItems(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 100)
  }

  @Get(':id')
  getCampaign(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCampaign(u.orgId, id)
  }

  @Get(':id/items')
  listItemsForCampaign(
    @ReqUser() u: ReqUserPayload,
    @Param('id') campaignId: string,
    @Query('seller_id')      sellerId?:    string,
    @Query('status')         status?:      string,
    @Query('health_status')  healthStatus?:string,
    @Query('has_subsidy')    hasSubsidy?:  string,
    @Query('q')              q?:           string,
    @Query('limit')          limit?:       string,
    @Query('offset')         offset?:      string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listItems({
      orgId:        u.orgId,
      sellerId:     sellerId ? Number(sellerId) : undefined,
      campaignId,
      status:       status       as any,
      healthStatus: healthStatus as any,
      hasSubsidy:   hasSubsidy === 'true' ? true : hasSubsidy === 'false' ? false : undefined,
      q,
      limit:        limit  ? Number(limit)  : 50,
      offset:       offset ? Number(offset) : 0,
    })
  }

  // ── Items (visao por anuncio) ────────────────────────────────────

  @Get('items/list')
  listAllItems(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')      sellerId?:    string,
    @Query('status')         status?:      string,
    @Query('health_status')  healthStatus?:string,
    @Query('has_subsidy')    hasSubsidy?:  string,
    @Query('q')              q?:           string,
    @Query('limit')          limit?:       string,
    @Query('offset')         offset?:      string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listItems({
      orgId:        u.orgId,
      sellerId:     sellerId ? Number(sellerId) : undefined,
      status:       status       as any,
      healthStatus: healthStatus as any,
      hasSubsidy:   hasSubsidy === 'true' ? true : hasSubsidy === 'false' ? false : undefined,
      q,
      limit:        limit  ? Number(limit)  : 50,
      offset:       offset ? Number(offset) : 0,
    })
  }

  @Get('items/:itemId/promotions')
  getItemPromotions(
    @ReqUser() u: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getItemPromotions(u.orgId, itemId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Sync ────────────────────────────────────────────────────────

  @Post('sync')
  syncOrg(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.syncOrg(u.orgId, { sellerId: sellerId ? Number(sellerId) : undefined })
  }

  @Get('sync/logs')
  syncLogs(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSyncLogs(u.orgId, limit ? Number(limit) : 20)
  }
}
