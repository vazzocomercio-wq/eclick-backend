import {
  Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'
import { ReturnsSacBridgeService } from './returns-sac.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Devolução → ticket no CRM (SAC): sync manual, status e card de pedido. */
@Controller('returns-sac')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ReturnsSacController {
  constructor(private readonly sac: ReturnsSacBridgeService) {}

  @Get('status')
  @RequirePermission('crm.view')
  async status(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.sac.status(user.orgId)
  }

  /** Roda a ponte AGORA (cria cards das abertas + move quem mudou). */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  async run(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.sac.syncOrg(user.orgId)
  }

  /** Botão "Vincular ao SAC" da tela de pedidos — card manual pro pedido
   *  (mesmo sem devolução). Permissão orders.view de propósito: a ação mora
   *  na tela de pedidos e o card é interno (CRM), sem efeito externo. */
  @Post('order-card')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  async orderCard(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { source?: string; external_order_id?: string; note?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.sac.linkOrderSac(user.orgId, body)
  }
}
