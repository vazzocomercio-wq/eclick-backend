import {
  Controller, Get, Query, UseGuards, BadRequestException,
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
}
