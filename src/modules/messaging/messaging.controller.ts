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

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('messaging')
@UseGuards(SupabaseAuthGuard)
export class MessagingController {
  constructor(private readonly svc: MessagingService) {}

  // ── Templates ───────────────────────────────────────────────────────────

  @Get('templates')
  listTemplates(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listTemplates(user.orgId)
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  createTemplate(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<MessagingTemplate>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createTemplate(user.orgId, body)
  }

  @Patch('templates/:id')
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
  listJourneys(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listJourneys(user.orgId)
  }

  @Post('journeys')
  @HttpCode(HttpStatus.CREATED)
  createJourney(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<MessagingJourney>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createJourney(user.orgId, body)
  }

  @Patch('journeys/:id')
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
}
