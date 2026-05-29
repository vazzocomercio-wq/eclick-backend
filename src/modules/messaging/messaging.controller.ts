import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, HttpCode, HttpStatus,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import {
  MessagingService, MessagingTemplate, MessagingJourney,
} from './messaging.service'
import { JourneyEngineService } from './journey-engine.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('messaging')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class MessagingController {
  constructor(
    private readonly svc:    MessagingService,
    private readonly engine: JourneyEngineService,
  ) {}

  // ── Templates ───────────────────────────────────────────────────────────

  @Get('templates')
  @RequirePermission('crm.view')
  listTemplates(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listTemplates(user.orgId)
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('crm.message')
  createTemplate(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<MessagingTemplate>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createTemplate(user.orgId, body)
  }

  @Patch('templates/:id')
  @RequirePermission('crm.message')
  updateTemplate(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<MessagingTemplate>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateTemplate(user.orgId, id, body)
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  deleteTemplate(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteTemplate(user.orgId, id)
  }

  /** POST /messaging/templates/:id/preview { phone, context } — renderiza
   * + envia teste via WhatsApp + persiste em messaging_sends. */
  @Post('templates/:id/preview')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  previewTemplate(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { phone: string; context?: Record<string, unknown> },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.previewTemplate(user.orgId, id, body)
  }

  // ── Journeys ────────────────────────────────────────────────────────────

  @Get('journeys')
  @RequirePermission('crm.view')
  listJourneys(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listJourneys(user.orgId)
  }

  @Post('journeys')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('crm.manage_pipeline')
  createJourney(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<MessagingJourney>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createJourney(user.orgId, body)
  }

  @Patch('journeys/:id')
  @RequirePermission('crm.manage_pipeline')
  updateJourney(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<MessagingJourney>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateJourney(user.orgId, id, body)
  }

  @Delete('journeys/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.manage_pipeline')
  deleteJourney(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteJourney(user.orgId, id)
  }

  /** POST /messaging/journeys/:id/trigger — dispara manualmente (cria
   * messaging_journey_runs com next_step_at=now). Engine (C2) processa. */
  @Post('journeys/:id/trigger')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.manage_pipeline')
  triggerJourney(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      order_id?:    string
      customer_id?: string
      phone:        string
      context?:     Record<string, unknown>
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.triggerJourney(user.orgId, id, body)
  }

  // ── Campaigns ───────────────────────────────────────────────────────────

  /** POST /messaging/campaigns/send
   *   { template_id, segment, customer_ids?, message_override? }
   * Dispara em massa; cap 500/call (50s @ 100ms/send). */
  @Post('campaigns/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  sendCampaign(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      template_id:       string
      segment:           'all' | 'with_cpf' | 'vip' | 'custom'
      customer_ids?:     string[]
      message_override?: string
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.sendCampaign(user.orgId, body)
  }

  // ── Analytics ───────────────────────────────────────────────────────────

  /** GET /messaging/analytics?from=&to= */
  @Get('analytics')
  @RequirePermission('crm.view')
  getAnalytics(
    @ReqUser() user: ReqUserPayload,
    @Query('from') from?: string,
    @Query('to')   to?:   string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAnalytics(user.orgId, from, to)
  }

  // ── Sends ───────────────────────────────────────────────────────────────

  /** GET /messaging/sends?status=&from=&to=&customer_id=&journey_id=
   *                       &limit=&offset= */
  @Get('sends')
  @RequirePermission('crm.view')
  listSends(
    @ReqUser() user: ReqUserPayload,
    @Query('status')      status?:     string,
    @Query('from')        from?:       string,
    @Query('to')          to?:         string,
    @Query('customer_id') customerId?: string,
    @Query('journey_id')  journeyId?:  string,
    @Query('limit')       limit?:      string,
    @Query('offset')      offset?:     string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listSends(user.orgId, {
      status, from, to,
      customer_id: customerId,
      journey_id:  journeyId,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  // ── Runs (CC-2) ─────────────────────────────────────────────────────────

  /** GET /messaging/runs?status=&journey_id=&customer_id=&from=&to=
   *                      &limit=&offset= */
  @Get('runs')
  @RequirePermission('crm.view')
  listRuns(
    @ReqUser() user: ReqUserPayload,
    @Query('status')      status?:     string,
    @Query('journey_id')  journeyId?:  string,
    @Query('customer_id') customerId?: string,
    @Query('from')        from?:       string,
    @Query('to')          to?:         string,
    @Query('limit')       limit?:      string,
    @Query('offset')      offset?:     string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listRuns(user.orgId, {
      status, from, to,
      journey_id:  journeyId,
      customer_id: customerId,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  /** POST /messaging/runs/process-now — força tick do JourneyEngine sem
   * esperar cron. Processa apenas runs da org do JWT (multi-tenant). */
  @Post('runs/process-now')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.manage_pipeline')
  processNow(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.engine.runOnce({ orgId: user.orgId })
  }

  @Get('runs/:id')
  @RequirePermission('crm.view')
  getRun(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getRun(user.orgId, id)
  }

  @Post('runs/:id/skip-step')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.manage_pipeline')
  skipStep(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.skipStep(user.orgId, id)
  }

  @Post('runs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.manage_pipeline')
  cancelRun(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body?: { reason?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.cancelRun(user.orgId, id, body?.reason)
  }

  // ── Bulk endpoints (stubs — chamados pela barra de /clientes) ──────────

  /** POST /messaging/send-bulk — STUB. Quando implementado, dispara um
   * texto livre pra N customer_ids. Hoje retorna { success: true, message }. */
  @Post('send-bulk')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  sendBulk(@Body() body: { customer_ids?: string[]; message?: string }) {
    const n = Array.isArray(body?.customer_ids) ? body.customer_ids.length : 0
    return { success: true, message: 'Em breve', total: n }
  }

  /** POST /messaging/journeys/start-bulk — STUB. Quando implementado,
   * insere N rows em order_communication_journeys (CC-1) ou messaging_journey_runs
   * conforme o journey_type. Hoje só ecoa { success, total }. */
  @Post('journeys/start-bulk')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.manage_pipeline')
  journeysStartBulk(@Body() body: { customer_ids?: string[]; journey_type?: string }) {
    const n = Array.isArray(body?.customer_ids) ? body.customer_ids.length : 0
    return { success: true, message: 'Em breve', total: n, journey_type: body?.journey_type ?? null }
  }
}
