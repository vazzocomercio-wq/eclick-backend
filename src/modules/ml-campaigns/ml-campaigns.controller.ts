import { Controller, Get, Post, Patch, Body, Query, Param, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MlCampaignsService } from './ml-campaigns.service'
import { MlCampaignsSyncService } from './ml-campaigns-sync.service'
import { MlCampaignsDecisionService } from './ml-campaigns-decision.service'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml-campaigns')
@UseGuards(SupabaseAuthGuard)
export class MlCampaignsController {
  constructor(
    private readonly svc:      MlCampaignsService,
    private readonly sync:     MlCampaignsSyncService,
    private readonly decision: MlCampaignsDecisionService,
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

  // ═══ Camada 2: Recommendations + Config ═══════════════════════════

  @Post('recommendations/generate')
  generateAll(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.decision.generateForOrg(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  @Post('recommendations/generate-item/:campaignItemId')
  generateForItem(
    @ReqUser() u: ReqUserPayload,
    @Param('campaignItemId') campaignItemId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.decision.generateForItem(campaignItemId)
  }

  @Get('recommendations')
  listRecommendations(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')      sellerId?:       string,
    @Query('classification') classification?: string,
    @Query('status')         status?:         string,
    @Query('min_score')      minScore?:       string,
    @Query('campaign_id')    campaignId?:     string,
    @Query('limit')          limit?:          string,
    @Query('offset')         offset?:         string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listRecommendations({
      orgId:           u.orgId,
      sellerId:        sellerId ? Number(sellerId) : undefined,
      classification,
      status:          status ?? 'pending',
      minScore:        minScore ? Number(minScore) : undefined,
      campaignId,
      limit:           limit  ? Number(limit)  : 50,
      offset:          offset ? Number(offset) : 0,
    })
  }

  @Get('recommendations/:id')
  getRecommendation(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getRecommendation(u.orgId, id)
  }

  @Post('recommendations/:id/approve')
  approveRecommendation(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { price?: number; quantity?: number },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const edited = (body?.price != null || body?.quantity != null)
      ? { price: body.price, quantity: body.quantity }
      : undefined
    return this.svc.approveRecommendation(u.orgId, id, u.id, edited)
  }

  @Post('recommendations/:id/reject')
  rejectRecommendation(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.rejectRecommendation(u.orgId, id, u.id)
  }

  // ── Config ─────────────────────────────────────────────────────────

  @Get('config')
  getConfig(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!sellerId)  throw new BadRequestException('seller_id obrigatorio')
    return this.svc.getConfig(u.orgId, Number(sellerId))
  }

  @Patch('config')
  updateConfig(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId: string,
    @Body() patch: Record<string, unknown>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!sellerId)  throw new BadRequestException('seller_id obrigatorio')
    return this.svc.updateConfig(u.orgId, Number(sellerId), patch)
  }

  @Get('ai-usage')
  aiUsage(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAiUsageToday(u.orgId)
  }
}
