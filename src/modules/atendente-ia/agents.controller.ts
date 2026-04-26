import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { AgentsService } from './agents.service'
import { ConversationsService } from './conversations.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('atendente-ia')
@UseGuards(SupabaseAuthGuard)
export class AgentsController {
  constructor(
    private readonly svc:           AgentsService,
    private readonly conversations: ConversationsService,
  ) {}

  // ── Agents ────────────────────────────────────────────────────────────────

  @Get('agents')
  list(@ReqUser() u: ReqUserPayload) {
    return this.svc.listAgents(u.orgId!)
  }

  @Get('agents/:id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.getAgent(u.orgId!, id)
  }

  @Post('agents')
  create(@ReqUser() u: ReqUserPayload, @Body() body: Parameters<AgentsService['createAgent']>[1]) {
    return this.svc.createAgent(u.orgId!, body)
  }

  @Patch('agents/:id')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Parameters<AgentsService['updateAgent']>[2],
  ) {
    return this.svc.updateAgent(u.orgId!, id, body)
  }

  @Patch('agents/:id/toggle')
  @HttpCode(HttpStatus.OK)
  toggle(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.toggleAgent(u.orgId!, id)
  }

  @Delete('agents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteAgent(u.orgId!, id)
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  @Post('agents/:id/channels/:channel')
  upsertChannel(
    @Param('id') agentId: string,
    @Param('channel') channel: string,
    @Body() body: Parameters<AgentsService['upsertChannel']>[2],
  ) {
    return this.svc.upsertChannel(agentId, channel, body)
  }

  @Delete('agents/:id/channels/:channel')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteChannel(@Param('id') agentId: string, @Param('channel') channel: string) {
    return this.svc.deleteChannel(agentId, channel)
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────

  @Get('agents/:id/knowledge')
  listKnowledge(@Param('id') agentId: string) {
    return this.svc.listKnowledge(agentId)
  }

  @Post('agents/:id/knowledge')
  createKnowledge(
    @Param('id') agentId: string,
    @Body() body: Parameters<AgentsService['createKnowledge']>[1],
  ) {
    return this.svc.createKnowledge(agentId, body)
  }

  @Patch('knowledge/:id')
  updateKnowledge(
    @Param('id') id: string,
    @Body() body: Parameters<AgentsService['updateKnowledge']>[1],
  ) {
    return this.svc.updateKnowledge(id, body)
  }

  @Delete('knowledge/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteKnowledge(@Param('id') id: string) {
    return this.svc.deleteKnowledge(id)
  }

  // ── Training ──────────────────────────────────────────────────────────────

  @Get('agents/:id/training')
  listTraining(@Param('id') agentId: string) {
    return this.svc.listTraining(agentId)
  }

  @Post('agents/:id/training')
  createTraining(
    @Param('id') agentId: string,
    @Body() body: Parameters<AgentsService['createTraining']>[1],
  ) {
    return this.svc.createTraining(agentId, body)
  }

  @Patch('training/:id/validate')
  @HttpCode(HttpStatus.OK)
  validateTraining(@Param('id') id: string) {
    return this.svc.validateTraining(id)
  }

  @Delete('training/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTraining(@Param('id') id: string) {
    return this.svc.deleteTraining(id)
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  @Get('analytics')
  getAnalytics(
    @Query('agent_id') agentId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const defaultFrom = new Date(Date.now() - 30 * 86400 * 1000).toISOString().split('T')[0]
    const defaultTo   = new Date().toISOString().split('T')[0]
    return this.svc.getAnalytics(agentId, from ?? defaultFrom, to ?? defaultTo)
  }

  @Get('analytics/top-questions')
  topQuestions(
    @ReqUser() u: ReqUserPayload,
    @Query('limit') limit?: string,
  ) {
    return this.conversations.topQuestions(u.orgId!, limit ? Number(limit) : 10)
  }

  @Get('analytics/by-agent')
  byAgent(
    @ReqUser() u: ReqUserPayload,
    @Query('days') days?: string,
  ) {
    return this.conversations.performanceByAgent(u.orgId!, days ? Number(days) : 30)
  }

  @Get('analytics/insights')
  insights(@Query('limit') limit?: string) {
    return this.conversations.listInsights(limit ? Number(limit) : 10)
  }
}
