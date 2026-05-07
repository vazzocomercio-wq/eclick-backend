import { Controller, Get, Post, Patch, Body, Query, Param, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { MlCampaignsService } from './ml-campaigns.service'
import { MlCampaignsSyncService } from './ml-campaigns-sync.service'
import { MlCampaignsDecisionService } from './ml-campaigns-decision.service'
import { MlCampaignsValidatorService } from './ml-campaigns-validator.service'
import { MlCampaignsApplyService } from './ml-campaigns-apply.service'
import { MlCampaignsPostAnalysisService } from './ml-campaigns-post-analysis.service'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml-campaigns')
@UseGuards(SupabaseAuthGuard)
export class MlCampaignsController {
  constructor(
    private readonly svc:        MlCampaignsService,
    private readonly sync:       MlCampaignsSyncService,
    private readonly decision:   MlCampaignsDecisionService,
    private readonly validator:  MlCampaignsValidatorService,
    private readonly apply:      MlCampaignsApplyService,
    private readonly post:       MlCampaignsPostAnalysisService,
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

  // ═══ Camada 3: Apply + Auditoria ═════════════════════════════════════

  @Post('validate')
  validateRecommendations(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { recommendation_ids: string[] },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.recommendation_ids) || body.recommendation_ids.length === 0) {
      throw new BadRequestException('recommendation_ids[] obrigatorio')
    }
    return this.validator.validateMany(u.orgId, body.recommendation_ids)
  }

  @Post('apply/single')
  applySingle(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { recommendation_id: string; seller_id: number; apply_mode?: 'safe' | 'best_effort' },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.recommendation_id) throw new BadRequestException('recommendation_id obrigatorio')
    if (!body?.seller_id)         throw new BadRequestException('seller_id obrigatorio')
    return this.apply.applySingle({
      orgId:            u.orgId,
      sellerId:         Number(body.seller_id),
      userId:           u.id,
      recommendationId: body.recommendation_id,
      applyMode:        body.apply_mode ?? 'safe',
    })
  }

  @Post('apply/batch')
  applyBatch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { recommendation_ids: string[]; seller_id: number; apply_mode?: 'safe' | 'best_effort' },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.recommendation_ids) || body.recommendation_ids.length === 0) {
      throw new BadRequestException('recommendation_ids[] obrigatorio')
    }
    if (!body?.seller_id) throw new BadRequestException('seller_id obrigatorio')
    return this.apply.applyBatch({
      orgId:             u.orgId,
      sellerId:          Number(body.seller_id),
      userId:            u.id,
      recommendationIds: body.recommendation_ids,
      applyMode:         body.apply_mode ?? 'safe',
    })
  }

  @Post('leave/single')
  leaveSingle(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { campaign_item_id: string; seller_id: number },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.campaign_item_id) throw new BadRequestException('campaign_item_id obrigatorio')
    if (!body?.seller_id)         throw new BadRequestException('seller_id obrigatorio')
    return this.apply.leaveSingle(u.orgId, Number(body.seller_id), u.id, body.campaign_item_id)
  }

  @Get('apply/jobs')
  listApplyJobs(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.apply.listJobs(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 20)
  }

  @Get('apply/jobs/:id')
  getApplyJob(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.apply.getJob(u.orgId, id)
  }

  // ═══ Camada 4: Pos-analise + Aprendizado ═══════════════════════

  @Post('post-analysis/generate/:campaignId')
  generateAnalysis(
    @ReqUser() u: ReqUserPayload,
    @Param('campaignId') campaignId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.generateAnalysis(campaignId)
  }

  @Get('post-analysis')
  listAnalyses(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.listAnalyses(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 50)
  }

  @Get('post-analysis/:id')
  getAnalysis(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.getAnalysis(u.orgId, id)
  }

  @Get('post-analysis/campaign/:campaignId')
  getAnalysisByCampaign(
    @ReqUser() u: ReqUserPayload,
    @Param('campaignId') campaignId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.getAnalysisByCampaign(u.orgId, campaignId)
  }

  @Get('learnings')
  learnings(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.listLearnings(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  @Get('audit')
  audit(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')   sellerId?:   string,
    @Query('item_id')     itemId?:     string,
    @Query('campaign_id') campaignId?: string,
    @Query('limit')       limit?:      string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.apply.listAuditLog({
      orgId:      u.orgId,
      sellerId:   sellerId ? Number(sellerId) : undefined,
      mlItemId:   itemId,
      campaignId,
      limit:      limit ? Number(limit) : 100,
    })
  }
}
