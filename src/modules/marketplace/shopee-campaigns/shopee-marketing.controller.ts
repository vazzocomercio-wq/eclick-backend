import {
  Controller, Get, Post, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeMarketingService } from './shopee-marketing.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 Marketing inteligente — recomendações margem-aware + probe de escopo.
 *
 *  GET /shopee/marketing/recommendations?objectives=overstock,visibility,...
 *  GET /shopee/marketing/scope-probe  → flash sale module autorizado?  */
@Controller('shopee/marketing')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeMarketingController {
  constructor(private readonly svc: ShopeeMarketingService) {}

  @Get('recommendations')
  @RequirePermission('products.view')
  async recommendations(
    @ReqUser() user: ReqUserPayload,
    @Query('objectives') objectives?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const objs = objectives ? objectives.split(',').map(s => s.trim()).filter(Boolean) : undefined
    const lim = limit ? Math.min(Math.max(Number(limit) || 50, 1), 200) : 50
    return this.svc.recommend(user.orgId, objs, lim)
  }

  @Get('scope-probe')
  @RequirePermission('products.view')
  async scopeProbe(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.scopeProbe(user.orgId)
  }

  /** F18 Bloco 3 — APLICAR de verdade (cria a promoção na Shopee). ⚠️ promo real.
   *  vehicle='discount' suportado; flash_sale/voucher = próximos. dry_run só
   *  simula (margem guard); delete_after cria+remove pro teste de escopo. */
  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async apply(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { item_id?: number; discount_pct?: number; vehicle?: string; dry_run?: boolean; delete_after?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const itemId = Number(body?.item_id)
    if (!Number.isFinite(itemId)) throw new BadRequestException('item_id inválido')
    if (body?.discount_pct == null) throw new BadRequestException('discount_pct ausente')
    const vehicle = body.vehicle ?? 'discount'
    if (vehicle !== 'discount') {
      throw new BadRequestException(`Aplicar via "${vehicle}" ainda não disponível — por ora só Desconto. (Flash Sale/Cupom: próxima fase)`)
    }
    return this.svc.applyDiscount(user.orgId, itemId, Number(body.discount_pct), { dryRun: body.dry_run, deleteAfter: body.delete_after })
  }
}
