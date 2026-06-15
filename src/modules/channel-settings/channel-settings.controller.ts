import {
  Controller, Get, Post, Patch, Delete, Param, Body, UseGuards, BadRequestException,
} from '@nestjs/common'
import { ChannelSettingsService, Channel, FeeRuleInput } from './channel-settings.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

@Controller('channel-settings')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ChannelSettingsController {
  constructor(private readonly svc: ChannelSettingsService) {}

  /** Lista as configurações de canal da org (UI de Configurações > Canais). */
  @Get()
  @RequirePermission('settings.view')
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listForOrg(u.orgId)
  }

  /** Lê a config de UM canal (ex.: card de anúncios TikTok lê a comissão daqui). */
  @Get(':channel')
  @RequirePermission('settings.view')
  get(@ReqUser() u: ReqUserPayload, @Param('channel') channel: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(u.orgId, channel as Channel)
  }

  /** Atualiza/cria a config de UM canal (estimated_take_rate_pct, commission_fixed,
   *  notes). Aceita o nome legado `commission_pct` por back-compat. */
  @Patch(':channel')
  @RequirePermission('settings.update')
  upsert(
    @ReqUser() u: ReqUserPayload,
    @Param('channel') channel: string,
    @Body() body: { estimated_take_rate_pct?: number; commission_pct?: number; commission_fixed?: number; notes?: string | null },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.upsert(u.orgId, channel as Channel, body ?? {})
  }

  // ── Regras de take por faixa/categoria (channel_fee_rules) ────────────────

  /** Lista as regras de take do canal (gestão). */
  @Get(':channel/fee-rules')
  @RequirePermission('settings.view')
  listFeeRules(@ReqUser() u: ReqUserPayload, @Param('channel') channel: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listFeeRules(u.orgId, channel as Channel)
  }

  /** Cria uma regra de take pro canal. */
  @Post(':channel/fee-rules')
  @RequirePermission('settings.update')
  createFeeRule(@ReqUser() u: ReqUserPayload, @Param('channel') channel: string, @Body() body: FeeRuleInput) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createFeeRule(u.orgId, channel as Channel, body)
  }

  /** Atualiza uma regra (por id). */
  @Patch('fee-rules/:id')
  @RequirePermission('settings.update')
  updateFeeRule(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<FeeRuleInput>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateFeeRule(u.orgId, id, body ?? {})
  }

  /** Remove uma regra (por id). */
  @Delete('fee-rules/:id')
  @RequirePermission('settings.update')
  deleteFeeRule(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteFeeRule(u.orgId, id)
  }
}
