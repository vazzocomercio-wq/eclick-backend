import {
  Controller, Get, Post, Put, Param, Body, UseGuards, HttpCode, HttpStatus, BadRequestException, Query,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'
import { ShopeeReturnsPlaybookService } from './shopee-returns-playbook.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Playbook IA de Devoluções (Shopee). Leitura/análise = orders.view;
 *  ações (aceitar/disputar = ESCRITA REAL na Shopee) = orders.refund. */
@Controller('shopee/returns-playbook')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeReturnsPlaybookController {
  constructor(private readonly playbook: ShopeeReturnsPlaybookService) {}

  /** Gera/atualiza recomendações pras devoluções abertas (force reanalisa). */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.view')
  async run(@ReqUser() user: ReqUserPayload, @Query('force') force?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.analyzeAll(user.orgId, { force: force === 'true' })
  }

  /** Dossiê live (detail + soluções + motivos de disputa) pro drawer. */
  @Get(':returnSn/dossier')
  @RequirePermission('orders.view')
  async dossier(@ReqUser() user: ReqUserPayload, @Param('returnSn') returnSn: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.dossier(user.orgId, returnSn)
  }

  /** ⚠️ Aceita a devolução/reembolso na Shopee (escrita real). */
  @Post(':returnSn/accept')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.refund')
  async accept(@ReqUser() user: ReqUserPayload, @Param('returnSn') returnSn: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.accept(user.orgId, returnSn, user.id)
  }

  /** ⚠️ Aceita a OFERTA pendente do comprador (escrita real). */
  @Post(':returnSn/accept-offer')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.refund')
  async acceptOffer(@ReqUser() user: ReqUserPayload, @Param('returnSn') returnSn: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.acceptOffer(user.orgId, returnSn, user.id)
  }

  /** ⚠️ Abre DISPUTA na Shopee (escrita real; sempre humana). */
  @Post(':returnSn/dispute')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.refund')
  async dispute(
    @ReqUser() user: ReqUserPayload,
    @Param('returnSn') returnSn: string,
    @Body() body: { dispute_reason: number; text?: string; images?: string[]; email?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.dispute(user.orgId, returnSn, user.id, {
      disputeReason: Number(body?.dispute_reason),
      text:          body?.text,
      images:        Array.isArray(body?.images) ? body.images : undefined,
      email:         body?.email,
    })
  }

  /** Config do modo AUTO (opt-in por org). */
  @Get('config')
  @RequirePermission('orders.view')
  async getConfig(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.getConfig(user.orgId)
  }

  @Put('config')
  @RequirePermission('orders.refund')
  async saveConfig(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { enabled?: boolean; auto_accept_max_amount?: number; reverse_shipping_cost?: number; handling_cost?: number },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.playbook.saveConfig(user.orgId, body ?? {})
  }
}
