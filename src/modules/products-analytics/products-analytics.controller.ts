import {
  Controller, Get, Param, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { ProductsAnalyticsService } from './products-analytics.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 3 / S6 — Analytics social/ads agregadas no produto.
 *
 * GET /products/:id/analytics-social
 * GET /products/analytics-social/top?limit=10
 */
@Controller('products')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ProductsAnalyticsController {
  constructor(private readonly svc: ProductsAnalyticsService) {}

  @Get('analytics-social/top')
  @RequirePermission('products.view')
  top(
    @ReqUser() u: ReqUserPayload,
    @Query('limit') limitRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const limit = limitRaw ? parseInt(limitRaw, 10) : 10
    return this.svc.topAnalytics(u.orgId, limit)
  }

  @Get(':id/analytics-social')
  @RequirePermission('products.view')
  one(
    @ReqUser() u: ReqUserPayload,
    @Param('id') productId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getProductAnalytics(u.orgId, productId)
  }
}
