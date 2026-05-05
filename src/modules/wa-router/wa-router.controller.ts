import {
  Controller, Get, Post, Delete, Body, Param, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { ChannelRouterService } from './channel-router.service'
import type { WaPurpose } from './wa-router.types'

interface ReqUserPayload { id: string; orgId: string | null }

const VALID_PURPOSES: WaPurpose[] = [
  'internal_alert',
  'manager_verification',
  'customer_journey',
  'customer_campaign',
  'auth_2fa',
]

/**
 * Endpoints CRUD pra communication_channel_assignments. Consumido pela
 * UI COM-3 (`/dashboard/configuracoes/whatsapp-rotas`).
 */
@Controller('wa-router/assignments')
@UseGuards(SupabaseAuthGuard)
export class WaRouterController {
  constructor(private readonly router: ChannelRouterService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.router.listAssignments(u.orgId)
  }

  /** GET /wa-router/assignments/channels — lista unificada Baileys + Cloud
   * pra a UI montar dropdowns. */
  @Get('channels')
  channels(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.router.listAvailableChannels(u.orgId)
  }

  @Post()
  upsert(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      purpose:             WaPurpose
      baileys_channel_id?: string | null
      whatsapp_config_id?: string | null
      notes?:              string | null
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!VALID_PURPOSES.includes(body.purpose)) {
      throw new BadRequestException(`purpose inválido (deve ser um de: ${VALID_PURPOSES.join(', ')})`)
    }
    return this.router.upsertAssignment(u.orgId, body)
  }

  @Delete(':purpose')
  remove(
    @ReqUser() u: ReqUserPayload,
    @Param('purpose') purpose: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!VALID_PURPOSES.includes(purpose as WaPurpose)) {
      throw new BadRequestException(`purpose inválido`)
    }
    return this.router.deleteAssignment(u.orgId, purpose as WaPurpose)
  }
}
