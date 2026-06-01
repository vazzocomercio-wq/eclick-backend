import {
  Controller, Post, Get, Param, Body, UseGuards,
  HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeListingLinkService } from './shopee-listing-link.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 Fase A — Vínculo anúncio Shopee ↔ produto (keystone do nível de edição).
 *
 *  POST /shopee/listings/auto-link        → casa model_sku → products.sku em lote.
 *  GET  /shopee/listings/link-status      → cada anúncio + produto vinculado (UI).
 *  POST /shopee/listings/:itemId/link     → vínculo manual { product_id }.
 *  POST /shopee/listings/:itemId/unlink   → desvincula.
 *
 *  Prefixo coexiste com ShopeeListingsController (GET scores) — Nest resolve por
 *  rota. products.view: consistente com os demais endpoints de sync Shopee. */
@Controller('shopee/listings')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeListingLinkController {
  constructor(private readonly link: ShopeeListingLinkService) {}

  @Post('auto-link')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async autoLink(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.link.autoLinkAll(user.orgId)
  }

  @Get('link-status')
  @RequirePermission('products.view')
  async linkStatus(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.link.getLinkStatus(user.orgId)
  }

  @Post(':itemId/link')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async manualLink(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Body() body: { product_id?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    if (!body?.product_id) throw new BadRequestException('product_id ausente')
    return this.link.manualLink(user.orgId, id, body.product_id)
  }

  @Post(':itemId/unlink')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async unlink(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    return this.link.unlink(user.orgId, id)
  }
}
