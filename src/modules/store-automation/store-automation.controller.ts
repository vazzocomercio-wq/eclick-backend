import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import { StoreAutomationService } from './store-automation.service'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import type {
  AutomationStatus, AutomationTrigger, AutomationSeverity,
  StoreAutomationConfig,
} from './store-automation.types'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 4 / A3 — Store Automation endpoints.
 *
 * GET    /store-automation/actions
 * GET    /store-automation/actions/:id
 * POST   /store-automation/actions/:id/approve
 * POST   /store-automation/actions/:id/reject
 * POST   /store-automation/actions/approve-batch
 * POST   /store-automation/actions/:id/feedback
 * GET    /store-automation/config
 * PATCH  /store-automation/config
 * POST   /store-automation/analyze
 * GET    /store-automation/stats
 */
@Controller('store-automation')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StoreAutomationController {
  constructor(
    private readonly svc:    StoreAutomationService,
    private readonly bridge: ActiveBridgeClient,
  ) {}

  /** GET /store-automation/bridge-health — smoke test do bridge SaaS↔Active.
   *  Usa notify-lojista com severity='low' (digest, não spam). */
  @Get('bridge-health')
  @RequirePermission('store.view')
  bridgeHealth(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.bridge.pingBridge(u.orgId)
  }

  @Get('actions')
  @RequirePermission('store.view')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status')        status?:    AutomationStatus,
    @Query('trigger_type')  trigger?:   AutomationTrigger,
    @Query('severity')      severity?:  AutomationSeverity,
    @Query('limit')         limitRaw?:  string,
    @Query('offset')        offsetRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listActions(u.orgId, {
      status, trigger_type: trigger, severity,
      limit:  limitRaw  ? parseInt(limitRaw, 10)  : undefined,
      offset: offsetRaw ? parseInt(offsetRaw, 10) : undefined,
    })
  }

  @Get('stats')
  @RequirePermission('store.view')
  stats(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.stats(u.orgId)
  }

  @Get('config')
  @RequirePermission('settings.view')
  getConfig(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getConfig(u.orgId)
  }

  @Patch('config')
  @RequirePermission('settings.update')
  updateConfig(
    @ReqUser() u: ReqUserPayload,
    @Body() body: Partial<StoreAutomationConfig>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateConfig(u.orgId, body)
  }

  @Post('analyze')
  @RequirePermission('store.update')
  @HttpCode(HttpStatus.OK)
  analyze(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.analyze(u.orgId)
  }

  @Get('actions/:id')
  @RequirePermission('store.view')
  getAction(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAction(id, u.orgId)
  }

  @Post('actions/:id/approve')
  @RequirePermission('store.update')
  @HttpCode(HttpStatus.OK)
  approve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approve(id, u.orgId)
  }

  @Post('actions/:id/reject')
  @RequirePermission('store.update')
  @HttpCode(HttpStatus.OK)
  reject(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { feedback?: 'util'|'nao_relevante'|'timing_ruim'|'acao_errada' } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.reject(id, u.orgId, body.feedback)
  }

  @Post('actions/approve-batch')
  @RequirePermission('store.update')
  @HttpCode(HttpStatus.OK)
  approveBatch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { ids: string[] },
  ) {
    if (!u.orgId)              throw new BadRequestException('orgId ausente')
    if (!body?.ids?.length)    throw new BadRequestException('ids obrigatório')
    return this.svc.approveBatch(u.orgId, body.ids)
  }

  @Post('actions/:id/feedback')
  @RequirePermission('store.update')
  @HttpCode(HttpStatus.OK)
  feedback(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { feedback: 'util'|'nao_relevante'|'timing_ruim'|'acao_errada' },
  ) {
    if (!u.orgId)              throw new BadRequestException('orgId ausente')
    if (!body?.feedback)       throw new BadRequestException('feedback obrigatório')
    return this.svc.setFeedback(id, u.orgId, body.feedback)
  }
}
