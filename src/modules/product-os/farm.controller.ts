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
}
