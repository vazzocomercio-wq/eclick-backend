import {
  Controller, Get, Patch, Param, Body, UseGuards, BadRequestException,
} from '@nestjs/common'
import { ChannelSettingsService, Channel } from './channel-settings.service'
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

  /** Atualiza/cria a config de UM canal (commission_pct, commission_fixed, notes). */
  @Patch(':channel')
  @RequirePermission('settings.update')
  upsert(
    @ReqUser() u: ReqUserPayload,
    @Param('channel') channel: string,
    @Body() body: { commission_pct?: number; commission_fixed?: number; notes?: string | null },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.upsert(u.orgId, channel as Channel, body ?? {})
  }
}
