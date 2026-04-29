import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { CommunicationCenterService, CommunicationSettings } from '../services/communication-center.service'
import { MessagingTemplate, MessagingJourney } from '../../messaging/messaging.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Endpoints REST do Centro de Comunicação. Auth Bearer via SupabaseAuthGuard,
 * org-scoped via ReqUser.orgId. Templates reusam MessagingService;
 * journeys/settings/dashboard são lógica nova. */
@Controller('communication')
@UseGuards(SupabaseAuthGuard)
export class CommunicationCenterController {
  constructor(private readonly svc: CommunicationCenterService) {}

  // ── Journeys ────────────────────────────────────────────────────────────

  /** GET /communication/journeys?state=&limit= */
  @Get('journeys')
  listJourneys(
    @ReqUser() user: ReqUserPayload,
    @Query('state') state?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listJourneys(user.orgId, {
      state,
      limit: limit ? Number(limit) : undefined,
    })
  }

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

  /** Soft delete — UPDATE is_active=false. Preserva histórico de runs/sends. */
  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  deleteTemplate(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.softDeleteTemplate(user.orgId, id)
  }

  // ── Journey Templates (modelos de jornada) ──────────────────────────────

  @Get('journeys-templates')
  listJourneyTemplates(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listJourneyTemplates(user.orgId)
  }

  @Post('journeys-templates')
  @HttpCode(HttpStatus.CREATED)
  createJourneyTemplate(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<MessagingJourney>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createJourneyTemplate(user.orgId, body)
  }

  @Patch('journeys-templates/:id')
  updateJourneyTemplate(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<MessagingJourney>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateJourneyTemplate(user.orgId, id, body)
  }

  /** Soft delete — UPDATE is_active=false. Preserva runs históricas;
   * engine CC-2 skipa journeys inativas. */
  @Delete('journeys-templates/:id')
  @HttpCode(HttpStatus.OK)
  deleteJourneyTemplate(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.softDeleteJourneyTemplate(user.orgId, id)
  }

  // ── Settings ────────────────────────────────────────────────────────────

  @Get('settings')
  getSettings(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(user.orgId)
  }

  @Patch('settings')
  updateSettings(
    @ReqUser() user: ReqUserPayload,
    @Body() body: Partial<CommunicationSettings>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(user.orgId, body)
  }

  // ── Dashboard ───────────────────────────────────────────────────────────

  /** GET /communication/dashboard/funnel — contagens últimos 30 dias. */
  @Get('dashboard/funnel')
  getFunnel(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getFunnel(user.orgId)
  }

  /** GET /communication/dashboard/timeline?days=30 — agregado por dia. */
  @Get('dashboard/timeline')
  getTimeline(
    @ReqUser() user: ReqUserPayload,
    @Query('days') days?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getTimeline(user.orgId, days ? Number(days) : 30)
  }
}
