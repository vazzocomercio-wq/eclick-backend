import {
  Controller, Get, Post, Patch, Delete, Param, Body,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { PromotionCampaignsService, type PromotionCampaign } from './promotion-campaigns.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('store/config/campaigns')
@UseGuards(SupabaseAuthGuard)
export class PromotionCampaignsController {
  constructor(private readonly svc: PromotionCampaignsService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId)
  }

  @Get(':id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(u.orgId, id)
  }

  @Post()
  create(@ReqUser() u: ReqUserPayload, @Body() body: Partial<PromotionCampaign>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, body)
  }

  @Patch(':id')
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<PromotionCampaign>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete(':id')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }

  // ── Produtos da campanha ──────────────────────────────────────────

  /** POST /store/config/campaigns/:id/products  { productIds[] } */
  @Post(':id/products')
  addProducts(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { productIds: string[] },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.productIds)) throw new BadRequestException('productIds[] obrigatório')
    return this.svc.addProducts(u.orgId, id, body.productIds)
  }

  @Delete(':id/products/:productId')
  removeProduct(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Param('productId') productId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.removeProduct(u.orgId, id, productId)
  }

  /** PATCH /store/config/campaigns/:id/products/:productId
   *  Body: { discount_pct_override?, sale_price_override? } — override individual */
  @Patch(':id/products/:productId')
  setOverride(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() body: {
      discount_pct_override?: number | null
      sale_price_override?:   number | null
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setProductOverride(u.orgId, id, productId, body)
  }

  // ── Apply / Unapply ───────────────────────────────────────────────

  @Post(':id/apply')
  apply(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.apply(u.orgId, id)
  }

  @Post(':id/unapply')
  unapply(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.unapply(u.orgId, id)
  }
}
