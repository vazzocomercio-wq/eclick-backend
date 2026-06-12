import {
  Controller, Get, Post, Put, Body, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'
import { ReviewCentralService } from './review-central.service'
import { MlReviewsSyncService } from './ml-reviews-sync.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Central de Avaliações — config da automação + syncs multi-plataforma. */
@Controller('reviews/central')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ReviewCentralController {
  constructor(
    private readonly central: ReviewCentralService,
    private readonly mlSync:  MlReviewsSyncService,
  ) {}

  @Get('config')
  @RequirePermission('crm.view')
  async getConfig(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.central.getConfig(user.orgId)
  }

  /** Operadores do Active pro seletor (nome + WhatsApp do cadastro). */
  @Get('operators')
  @RequirePermission('crm.view')
  async operators(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return { operators: await this.central.listOperators(user.orgId) }
  }

  @Put('config')
  @RequirePermission('crm.message')
  async saveConfig(@ReqUser() user: ReqUserPayload, @Body() body: Record<string, unknown>) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.central.saveConfig(user.orgId, body)
  }

  /** Sync manual das avaliações do Mercado Livre. */
  @Post('sync-ml')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.view')
  async syncMl(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.mlSync.syncReviews(user.orgId)
  }

  /** ⚠️ Roda o piloto automático AGORA (publica respostas em positivas). */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  async run(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.central.runNow(user.orgId)
  }
}
