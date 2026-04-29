import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CampaignsService, Campaign, CampaignSegmentType } from './campaigns.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('campaigns')
@UseGuards(SupabaseAuthGuard)
export class CampaignsController {
  constructor(private readonly svc: CampaignsService) {}

  // ── List / CRUD ─────────────────────────────────────────────────────────

  @Get()
  list(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(user.orgId)
  }

  @Post()
  create(@ReqUser() user: ReqUserPayload, @Body() body: Partial<Campaign>) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(user.orgId, user.id, body)
  }

  @Get(':id')
  getOne(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getOne(user.orgId, id)
  }

  @Patch(':id')
  update(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<Campaign>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(user.orgId, id, body)
  }

  @Delete(':id')
  remove(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(user.orgId, id)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  @Post(':id/launch')
  launch(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.launch(user.orgId, id)
  }

  @Post(':id/pause')
  pause(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.pause(user.orgId, id)
  }

  @Post(':id/resume')
  resume(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.resume(user.orgId, id)
  }

  // ── Targets ─────────────────────────────────────────────────────────────

  @Get(':id/targets')
  listTargets(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Query('status')  status?: string,
    @Query('variant') variant?: string,
    @Query('limit')   limit?: string,
    @Query('offset')  offset?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listTargets(user.orgId, id, {
      status,
      variant,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  // ── Audience preview ────────────────────────────────────────────────────

  @Post('estimate-reach')
  estimateReach(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      segment_type:    CampaignSegmentType
      segment_filters?: Record<string, unknown> | null
      customer_ids?:    string[]
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.estimateReach(user.orgId, body)
  }

  // ── AI content ──────────────────────────────────────────────────────────

  @Post('generate-content')
  generateContent(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      objective:        string
      product_name?:    string
      tone?:            'amigavel' | 'profissional' | 'urgente'
      ab_variants?:     boolean
      providerOverride?: { provider: 'anthropic' | 'openai'; model: string }
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateContent(user.orgId, body)
  }

  // ── Debug / manual cron tick ────────────────────────────────────────────

  @Post('process-now')
  processNow(@ReqUser() user: ReqUserPayload) {
    // Não é segredo, mas evita strangers chamarem
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.runOnce()
  }
}
