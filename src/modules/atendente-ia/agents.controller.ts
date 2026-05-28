import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { AgentsService } from './agents.service'
import { ConversationsService } from './conversations.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('atendente-ia')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class AgentsController {
  constructor(
    private readonly svc:           AgentsService,
    private readonly conversations: ConversationsService,
  ) {}

  // ── Agents ────────────────────────────────────────────────────────────────

  @Get('agents')
  @RequirePermission('ai.view_usage')
  list(@ReqUser() u: ReqUserPayload) {
    return this.svc.listAgents(u.orgId!)
  }

  @Get('agents/:id')
  @RequirePermission('ai.view_usage')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.getAgent(u.orgId!, id)
  }

  @Post('agents')
  @RequirePermission('ai.manage_budget')
  create(@ReqUser() u: ReqUserPayload, @Body() body: Parameters<AgentsService['createAgent']>[1]) {
    return this.svc.createAgent(u.orgId!, body)
  }

  @Patch('agents/:id')
  @RequirePermission('ai.manage_budget')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Parameters<AgentsService['updateAgent']>[2],
  ) {
    return this.svc.updateAgent(u.orgId!, id, body)
  }

  @Patch('agents/:id/toggle')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai.manage_budget')
  toggle(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.toggleAgent(u.orgId!, id)
  }

  @Delete('agents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai.manage_budget')
  delete(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteAgent(u.orgId!, id)
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  @Post('agents/:id/channels/:channel')
  @RequirePermission('ai.manage_budget')
  upsertChannel(
    @ReqUser() u: ReqUserPayload,
    @Param('id') agentId: string,
    @Param('channel') channel: string,
    @Body() body: Parameters<AgentsService['upsertChannel']>[3],
  ) {
    return this.svc.upsertChannel(u.orgId!, agentId, channel, body)
  }

  @Delete('agents/:id/channels/:channel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai.manage_budget')
  deleteChannel(
    @ReqUser() u: ReqUserPayload,
    @Param('id') agentId: string,
    @Param('channel') channel: string,
  ) {
    return this.svc.deleteChannel(u.orgId!, agentId, channel)
  }

  // ── Knowledge ─────────────────────────────────────────────────────────────

  @Get('agents/:id/knowledge')
  @RequirePermission('ai.view_usage')
  listKnowledge(@ReqUser() u: ReqUserPayload, @Param('id') agentId: string) {
    return this.svc.listKnowledge(u.orgId!, agentId)
  }

  @Post('agents/:id/knowledge')
  @RequirePermission('ai.manage_budget')
  createKnowledge(
    @ReqUser() u: ReqUserPayload,
    @Param('id') agentId: string,
    @Body() body: Parameters<AgentsService['createKnowledge']>[2],
  ) {
    return this.svc.createKnowledge(u.orgId!, agentId, body)
  }

  @Patch('knowledge/:id')
  @RequirePermission('ai.manage_budget')
  updateKnowledge(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Parameters<AgentsService['updateKnowledge']>[2],
  ) {
    return this.svc.updateKnowledge(u.orgId!, id, body)
  }

  @Delete('knowledge/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai.manage_budget')
  deleteKnowledge(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteKnowledge(u.orgId!, id)
  }

  // ── Training ──────────────────────────────────────────────────────────────

  @Get('agents/:id/training')
  @RequirePermission('ai.view_usage')
  listTraining(@ReqUser() u: ReqUserPayload, @Param('id') agentId: string) {
    return this.svc.listTraining(u.orgId!, agentId)
  }

  @Post('agents/:id/training')
  @RequirePermission('ai.manage_budget')
  createTraining(
    @ReqUser() u: ReqUserPayload,
    @Param('id') agentId: string,
    @Body() body: Parameters<AgentsService['createTraining']>[2],
  ) {
    return this.svc.createTraining(u.orgId!, agentId, body)
  }

  @Patch('training/:id/validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai.manage_budget')
  validateTraining(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.validateTraining(u.orgId!, id)
  }

  @Delete('training/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('ai.manage_budget')
  deleteTraining(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteTraining(u.orgId!, id)
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  @Get('analytics')
  @RequirePermission('ai.view_usage')
  getAnalytics(
    @ReqUser() u: ReqUserPayload,
    @Query('agent_id') agentId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const defaultFrom = new Date(Date.now() - 30 * 86400 * 1000).toISOString().split('T')[0]
    const defaultTo   = new Date().toISOString().split('T')[0]
    return this.svc.getAnalytics(u.orgId!, agentId, from ?? defaultFrom, to ?? defaultTo)
  }

  @Get('analytics/top-questions')
  @RequirePermission('ai.view_usage')
  topQuestions(
    @ReqUser() u: ReqUserPayload,
    @Query('limit') limit?: string,
  ) {
    return this.conversations.topQuestions(u.orgId!, limit ? Number(limit) : 10)
  }

  @Get('analytics/by-agent')
  @RequirePermission('ai.view_usage')
  byAgent(
    @ReqUser() u: ReqUserPayload,
    @Query('days') days?: string,
  ) {
    return this.conversations.performanceByAgent(u.orgId!, days ? Number(days) : 30)
  }

  @Get('analytics/insights')
  @RequirePermission('ai.view_usage')
  insights(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    return this.conversations.listInsights(u.orgId!, limit ? Number(limit) : 10)
  }
}
