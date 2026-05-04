import {
  Controller, Get, Post, Patch, Param, Body, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { AlertHubConfigService } from './alert-hub-config.service'
import { AlertRoutingRulesService } from './alert-routing-rules.service'
import type { UpdateHubConfigDto } from './dto/update-hub-config.dto'
import type {
  CreateRoutingRuleDto, UpdateRoutingRuleDto,
} from './dto/routing-rule.dto'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Endpoints de configuração do Intelligence Hub:
 *   GET    /alert-hub/config            → config da org (cria default na primeira leitura)
 *   PATCH  /alert-hub/config            → atualiza
 *   POST   /alert-hub/enable            → ativa hub + cria 7 routing rules default
 *   POST   /alert-hub/disable           → pausa hub (não apaga rules)
 *   GET    /alert-hub/routing-rules     → lista regras
 *   POST   /alert-hub/routing-rules     → cria regra custom
 *   PATCH  /alert-hub/routing-rules/:id → edita regra
 *
 * Feed/stats ficam pra IH-3 (depois de analyzers/engine existirem).
 */
@Controller('alert-hub')
@UseGuards(SupabaseAuthGuard)
export class AlertHubController {
  constructor(
    private readonly configSvc: AlertHubConfigService,
    private readonly rulesSvc:  AlertRoutingRulesService,
  ) {}

  @Get('config')
  getConfig(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.configSvc.get(u.orgId)
  }

  @Patch('config')
  updateConfig(@ReqUser() u: ReqUserPayload, @Body() body: UpdateHubConfigDto) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.configSvc.update(u.orgId, body)
  }

  @Post('enable')
  async enable(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const config = await this.configSvc.setEnabled(u.orgId, true)
    const rules  = await this.rulesSvc.createDefaults(u.orgId)
    return { config, rules_created: rules.length }
  }

  @Post('disable')
  disable(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.configSvc.setEnabled(u.orgId, false)
  }

  @Get('routing-rules')
  listRules(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.rulesSvc.list(u.orgId)
  }

  @Post('routing-rules')
  createRule(@ReqUser() u: ReqUserPayload, @Body() body: CreateRoutingRuleDto) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.rulesSvc.create(u.orgId, body)
  }

  @Patch('routing-rules/:id')
  updateRule(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateRoutingRuleDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.rulesSvc.update(u.orgId, id, body)
  }
}
