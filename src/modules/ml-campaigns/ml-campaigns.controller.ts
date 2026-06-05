import { Controller, Get, Post, Patch, Body, Query, Param, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { MlCampaignsService } from './ml-campaigns.service'
import { MlCampaignsSyncService } from './ml-campaigns-sync.service'
import { MlCampaignsDecisionService } from './ml-campaigns-decision.service'
import { MlCampaignsValidatorService } from './ml-campaigns-validator.service'
import { MlCampaignsApplyService } from './ml-campaigns-apply.service'
import { MlCampaignsPostAnalysisService } from './ml-campaigns-post-analysis.service'
import { MlCampaignsAlertsService } from './ml-campaigns-alerts.service'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('ml-campaigns')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class MlCampaignsController {
  constructor(
    private readonly svc:        MlCampaignsService,
    private readonly sync:       MlCampaignsSyncService,
    private readonly decision:   MlCampaignsDecisionService,
    private readonly validator:  MlCampaignsValidatorService,
    private readonly apply:      MlCampaignsApplyService,
    private readonly post:       MlCampaignsPostAnalysisService,
    private readonly alerts:     MlCampaignsAlertsService,
  ) {}

  // ── Dashboard ──────────────────────────────────────────────────

  @Get('dashboard')
  @RequirePermission('ads.view')
  dashboard(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDashboard(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Campanhas ──────────────────────────────────────────────────

  @Get()
  @RequirePermission('ads.view')
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
  @RequirePermission('ads.view')
  deadlines(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')  sellerId?: string,
    @Query('days_ahead') days?:     string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getDeadlines(u.orgId, sellerId ? Number(sellerId) : undefined, days ? Number(days) : 7)
  }

  @Get('health')
  @RequirePermission('ads.view')
  health(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getMissingDataItems(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 100)
  }

  // ── Items (visao por anuncio) ────────────────────────────────────

  @Get('items/list')
  @RequirePermission('ads.view')
  listAllItems(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id')       sellerId?:      string,
    @Query('status')          status?:        string,
    @Query('health_status')   healthStatus?:  string,
    @Query('has_subsidy')     hasSubsidy?:    string,
    @Query('listing_status')  listingStatus?: string,
    @Query('catalog')         catalog?:       string,
    @Query('q')               q?:             string,
    @Query('limit')           limit?:         string,
    @Query('offset')          offset?:        string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listItems({
      orgId:          u.orgId,
      sellerId:       sellerId ? Number(sellerId) : undefined,
      status:         status        as any,
      healthStatus:   healthStatus  as any,
      hasSubsidy:     hasSubsidy === 'true' ? true : hasSubsidy === 'false' ? false : undefined,
      listingStatus:  listingStatus as any,
      catalogListing: catalog === 'true' ? true : catalog === 'false' ? false : undefined,
      q,
      limit:          limit  ? Number(limit)  : 50,
      offset:         offset ? Number(offset) : 0,
    })
  }

  @Get('items/:itemId/promotions')
  @RequirePermission('ads.view')
  getItemPromotions(
    @ReqUser() u: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getItemPromotions(u.orgId, itemId, sellerId ? Number(sellerId) : undefined)
  }

  // ── Tela escopada "Incluir em campanha" (por produto do catálogo) ──────

  /** Campanhas disponíveis + participando pra um PRODUTO do catálogo,
   *  agrupadas por anúncio. Fonte da tela do funil "Incluir em campanha". */
  @Get('listing/:productId/promotions')
  @RequirePermission('ads.view')
  listingPromotions(
    @ReqUser() u: ReqUserPayload,
    @Param('productId') productId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getListingPromotions(u.orgId, productId)
  }

  /** Participar direto de uma campanha (sem recomendação): inclui o anúncio
   *  no ML e avança o card do funil pra "Incluir ADS". */
  @Post('listing/join')
  @RequirePermission('ads.spend')
  listingJoin(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { campaign_item_id: string; offer_price?: number; discount_pct?: number },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.campaign_item_id) throw new BadRequestException('campaign_item_id é obrigatório')
    return this.apply.joinListingPromotion({
      orgId:          u.orgId,
      userId:         u.id,
      campaignItemId: body.campaign_item_id,
      offerPrice:     body.offer_price != null ? Number(body.offer_price) : undefined,
      discountPct:    body.discount_pct != null ? Number(body.discount_pct) : undefined,
    })
  }

  // ── Sync ────────────────────────────────────────────────────────

  @Post('sync')
  @RequirePermission('ads.view')
  syncOrg(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    // Fire-and-forget — sync demora 5+min, Railway tem timeout de HTTP.
    // Retorna log_id imediatamente, frontend polla /sync/logs pra status.
    return this.sync.syncOrgAsync(u.orgId, { sellerId: sellerId ? Number(sellerId) : undefined })
  }

  @Get('sync/logs')
  @RequirePermission('ads.view')
  syncLogs(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSyncLogs(u.orgId, limit ? Number(limit) : 20)
  }

  /** Fire-and-forget enrichment de thumbnails/titulos.
   *  Chamado pelo frontend apos load da lista pra preencher visuais
   *  sem bloquear render. Retorna { items_pending, started }. */
  @Post('sync/enrich-metadata')
  @RequirePermission('ads.view')
  enrichMetadata(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.enrichMetadataAsync(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  /** Recalcula health_status nos items existentes (sem chamar ML API).
   *  Use quando user atualiza custos/impostos no catalogo — em ~1s reflete
   *  o INCOMPLETE → ready sem aguardar sync ML completo. */
  @Post('sync/recompute-health')
  @RequirePermission('ads.view')
  recomputeHealth(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.sync.recomputeHealthStatus(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  // ═══ Camada 2: Recommendations + Config ═══════════════════════════

  @Post('recommendations/generate')
  @RequirePermission('ads.view')
  generateAll(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.decision.generateForOrg(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  @Post('recommendations/generate-item/:campaignItemId')
  @RequirePermission('ads.view')
  generateForItem(
    @ReqUser() u: ReqUserPayload,
    @Param('campaignItemId') campaignItemId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.decision.generateForItem(campaignItemId)
  }

  @Get('recommendations')
  @RequirePermission('ads.view')
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
  @RequirePermission('ads.view')
  getRecommendation(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getRecommendation(u.orgId, id)
  }

  @Post('recommendations/:id/approve')
  @RequirePermission('ads.update_budget')
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
  @RequirePermission('ads.update_budget')
  rejectRecommendation(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.rejectRecommendation(u.orgId, id, u.id)
  }

  // ─── Manager queue (soft gate margem) ──────────────────────────

  /** Lista recomendações que o operador tentou aprovar mas margem < gate */
  @Get('manager-queue')
  @RequirePermission('ads.view')
  managerQueue(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
    @Query('offset')    offset?:   string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listManagerQueue(
      u.orgId,
      sellerId ? Number(sellerId) : undefined,
      limit  ? Number(limit)  : 50,
      offset ? Number(offset) : 0,
    )
  }

  /** Gestor aprova override (libera pra apply) */
  @Post('recommendations/:id/manager-approve')
  @RequirePermission('ads.update_budget')
  managerApprove(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.managerApproveRecommendation(u.orgId, id, u.id, body?.reason)
  }

  /** Gestor rejeita override */
  @Post('recommendations/:id/manager-reject')
  @RequirePermission('ads.update_budget')
  managerReject(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.managerRejectRecommendation(u.orgId, id, u.id, body?.reason)
  }

  /** Audit: tentativas de um operador específico nos últimos 30d.
   *  Gestor pode usar antes de decidir um override. */
  @Get('audit/operator/:userId')
  @RequirePermission('ads.view')
  auditOperator(
    @ReqUser() u: ReqUserPayload,
    @Param('userId') userId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAuditOperatorAttempts(u.orgId, userId)
  }

  // ── Config ─────────────────────────────────────────────────────────

  @Get('config')
  @RequirePermission('settings.view')
  getConfig(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!sellerId)  throw new BadRequestException('seller_id obrigatorio')
    return this.svc.getConfig(u.orgId, Number(sellerId))
  }

  @Patch('config')
  @RequirePermission('settings.update')
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
  @RequirePermission('ai.view_usage')
  aiUsage(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAiUsageToday(u.orgId)
  }

  // ═══ Camada 3: Apply + Auditoria ═════════════════════════════════════

  @Post('validate')
  @RequirePermission('ads.view')
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
  @RequirePermission('ads.spend')
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
  @RequirePermission('ads.spend')
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
  @RequirePermission('ads.spend')
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
  @RequirePermission('ads.view')
  listApplyJobs(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.apply.listJobs(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 20)
  }

  @Get('apply/jobs/:id')
  @RequirePermission('ads.view')
  getApplyJob(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.apply.getJob(u.orgId, id)
  }

  // ═══ Camada 4: Pos-analise + Aprendizado ═══════════════════════

  @Post('post-analysis/generate/:campaignId')
  @RequirePermission('ads.view')
  generateAnalysis(
    @ReqUser() u: ReqUserPayload,
    @Param('campaignId') campaignId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.generateAnalysis(campaignId)
  }

  @Get('post-analysis')
  @RequirePermission('ads.view')
  listAnalyses(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.listAnalyses(u.orgId, sellerId ? Number(sellerId) : undefined, limit ? Number(limit) : 50)
  }

  @Get('post-analysis/:id')
  @RequirePermission('ads.view')
  getAnalysis(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.getAnalysis(u.orgId, id)
  }

  @Get('post-analysis/campaign/:campaignId')
  @RequirePermission('ads.view')
  getAnalysisByCampaign(
    @ReqUser() u: ReqUserPayload,
    @Param('campaignId') campaignId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.getAnalysisByCampaign(u.orgId, campaignId)
  }

  @Get('learnings')
  @RequirePermission('ads.view')
  learnings(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.post.listLearnings(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  @Get('audit')
  @RequirePermission('ads.view')
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

  // ─── Alerts (M2) ───────────────────────────────────────────────

  /** Roda a varredura de alertas agora, sem aguardar cron 9h.
   *  Útil pra testar config + ver mensagem chegar. */
  @Post('alerts/run')
  @RequirePermission('ads.view')
  runAlertsNow(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.alerts.runNow(u.orgId, sellerId ? Number(sellerId) : undefined)
  }

  /** Lista os últimos alertas enviados pra esta org (audit). */
  @Get('alerts/log')
  @RequirePermission('ads.view')
  async listAlerts(
    @ReqUser() u: ReqUserPayload,
    @Query('seller_id') sellerId?: string,
    @Query('limit')     limit?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const { supabaseAdmin } = await import('../../common/supabase')
    let q = supabaseAdmin
      .from('ml_campaign_alert_log')
      .select('*')
      .eq('organization_id', u.orgId)
      .order('created_at', { ascending: false })
      .limit(limit ? Number(limit) : 50)
    if (sellerId) q = q.eq('seller_id', Number(sellerId))
    const { data, error } = await q
    if (error) throw new BadRequestException(`alerts/log: ${error.message}`)
    return data ?? []
  }

  // ── Catch-all dynamic routes — DEVEM ficar por último ─────────────
  // NestJS resolve rotas na ORDEM de declaração. Se @Get(':id') vier
  // antes de @Get('recommendations'), 'recommendations' é capturado
  // como id e o getCampaign tenta validar como uuid, retornando 400.
  // Por isso ficam aqui no final, depois de todas as rotas estáticas.

  @Get(':id')
  @RequirePermission('ads.view')
  getCampaign(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCampaign(u.orgId, id)
  }

  @Get(':id/items')
  @RequirePermission('ads.view')
  listItemsForCampaign(
    @ReqUser() u: ReqUserPayload,
    @Param('id') campaignId: string,
    @Query('seller_id')       sellerId?:      string,
    @Query('status')          status?:        string,
    @Query('health_status')   healthStatus?:  string,
    @Query('has_subsidy')     hasSubsidy?:    string,
    @Query('listing_status')  listingStatus?: string,
    @Query('catalog')         catalog?:       string,
    @Query('q')               q?:             string,
    @Query('limit')           limit?:         string,
    @Query('offset')          offset?:        string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listItems({
      orgId:          u.orgId,
      sellerId:       sellerId ? Number(sellerId) : undefined,
      campaignId,
      status:         status        as any,
      healthStatus:   healthStatus  as any,
      hasSubsidy:     hasSubsidy === 'true' ? true : hasSubsidy === 'false' ? false : undefined,
      listingStatus:  listingStatus as any,
      catalogListing: catalog === 'true' ? true : catalog === 'false' ? false : undefined,
      q,
      limit:          limit  ? Number(limit)  : 50,
      offset:         offset ? Number(offset) : 0,
    })
  }
}
