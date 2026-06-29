import {
  Controller, Get, Post, Body, Param, Headers,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import { FarmService, type TelemetryPrinter } from './farm.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { Public } from '../../common/decorators/public.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/** Endpoint PÚBLICO de ingestão — o agente local autentica por token próprio
 *  (header x-farm-agent-token), não por login de usuário. */
@Controller('product-os/farm')
export class FarmIngestController {
  constructor(private readonly farm: FarmService) {}

  @Public()
  @Post('telemetry')
  @HttpCode(HttpStatus.OK)
  ingest(@Headers('x-farm-agent-token') token: string, @Body() body: { agent_version?: string; printers?: TelemetryPrinter[] }) {
    return this.farm.ingest(token, body ?? {})
  }

  @Public()
  @Post('camera')
  @HttpCode(HttpStatus.OK)
  ingestCamera(@Headers('x-farm-agent-token') token: string, @Body() body: { serial: string; image_base64: string }) {
    return this.farm.ingestCamera(token, body?.serial ?? '', body?.image_base64 ?? '')
  }
}

/** Gerenciamento do agente + leitura do estado ao vivo (login de usuário). */
@Controller('product-os/farm')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class FarmController {
  constructor(private readonly farm: FarmService) {}

  private org(u: ReqUserPayload): string {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return u.orgId
  }

  @Post('agents')
  @RequirePermission('products.update')
  createAgent(@ReqUser() u: ReqUserPayload, @Body() body: { name: string }) {
    return this.farm.createAgent(this.org(u), body?.name ?? 'Agente da fábrica')
  }

  @Get('agents')
  @RequirePermission('products.view')
  listAgents(@ReqUser() u: ReqUserPayload) { return this.farm.listAgents(this.org(u)) }

  @Post('agents/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  revoke(@ReqUser() u: ReqUserPayload, @Param('id') id: string) { return this.farm.revokeAgent(this.org(u), id) }

  @Get('status')
  @RequirePermission('products.view')
  status(@ReqUser() u: ReqUserPayload) { return this.farm.status(this.org(u)) }

  @Post('printers/:pid/command')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  command(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { type: string; payload?: Record<string, unknown> }) {
    if (!['pause', 'resume', 'stop', 'light_on', 'light_off'].includes(body?.type)) throw new BadRequestException('Comando inválido')
    return this.farm.enqueueCommand(this.org(u), pid, body.type, body.payload ?? {}, u.id)
  }

  @Post('orders/:oid/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  sendOrder(@ReqUser() u: ReqUserPayload, @Param('oid') oid: string) {
    return this.farm.sendOrderToPrinter(this.org(u), oid, u.id)
  }

  @Post('printers/:pid/ai-detection')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  aiDetection(@ReqUser() u: ReqUserPayload, @Param('pid') pid: string, @Body() body: { enabled: boolean; sensitivity?: string }) {
    return this.farm.setAiDetection(this.org(u), pid, !!body?.enabled, body?.sensitivity)
  }

  @Get('failures')
  @RequirePermission('products.view')
  failures(@ReqUser() u: ReqUserPayload) { return this.farm.listFailures(this.org(u)) }

  @Get('failure-stats')
  @RequirePermission('products.view')
  failureStats(@ReqUser() u: ReqUserPayload) { return this.farm.failureStats(this.org(u)) }

  @Post('failures/:id/ack')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  ackFailure(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { false_positive?: boolean }) {
    return this.farm.ackFailure(this.org(u), id, !!body?.false_positive, u.id)
  }

  @Get('scheduler')
  @RequirePermission('products.view')
  scheduler(@ReqUser() u: ReqUserPayload) { return this.farm.schedulerSuggest(this.org(u)) }

  @Get('schedule-plan')
  @RequirePermission('products.view')
  schedulePlan(@ReqUser() u: ReqUserPayload) { return this.farm.schedulePlan(this.org(u)) }

  @Post('scheduler/apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  schedulerApply(@ReqUser() u: ReqUserPayload, @Body() body: { assignments: Array<{ order_id: string; printer_id: string }> }) {
    return this.farm.schedulerApply(this.org(u), body?.assignments ?? [])
  }
}
