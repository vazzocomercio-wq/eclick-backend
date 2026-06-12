import {
  Controller, Get, Post, Param, Query, Body, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'
import { ShopeeReviewsService } from './shopee-reviews.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Central de Avaliações — Shopee. crm.view lê; crm.message sugere/responde
 *  (resposta é PÚBLICA no anúncio). */
@Controller('shopee/reviews')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeReviewsController {
  constructor(private readonly reviews: ShopeeReviewsService) {}

  @Get()
  @RequirePermission('crm.view')
  async list(
    @ReqUser() user: ReqUserPayload,
    @Query('rating')    rating?: string,
    @Query('unreplied') unreplied?: string,
    @Query('shop_id')   shopId?: string,
    @Query('with_text') withText?: string,
    @Query('limit')     limit?: string,
    @Query('offset')    offset?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.reviews.list(user.orgId, {
      rating:    rating ? Number(rating) : undefined,
      unreplied: unreplied === 'true',
      shopId,
      withText:  withText === 'true',
      limit:     limit  ? Number(limit)  : undefined,
      offset:    offset ? Number(offset) : undefined,
    })
  }

  /** Sync manual (mesma rotina do cron; body.full repagina o histórico). */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.view')
  async sync(@ReqUser() user: ReqUserPayload, @Body() body?: { full?: boolean }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.reviews.syncReviews(user.orgId, { full: body?.full === true })
  }

  /** IA: gera resposta sugerida (não publica nada). */
  @Post(':id/suggest')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  async suggest(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.reviews.suggest(user.orgId, id)
  }

  /** ⚠️ Publica resposta REAL na avaliação (visível no anúncio, sem editar depois). */
  @Post(':id/reply')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  async reply(@ReqUser() user: ReqUserPayload, @Param('id') id: string, @Body() body: { text?: string }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.reviews.reply(user.orgId, id, body?.text ?? '')
  }
}
