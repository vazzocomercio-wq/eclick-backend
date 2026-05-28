import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { StorefrontAnalyticsService } from './storefront-analytics.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Lojista — analytics da vitrine.
 *   GET /storefront-analytics?days=30  → funil + receita + top produtos + origem + tendência
 */
@Controller('storefront-analytics')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StorefrontAnalyticsController {
  constructor(private readonly svc: StorefrontAnalyticsService) {}

  @Get()
  @RequirePermission('store.view')
  overview(@ReqUser() u: ReqUserPayload, @Query('days') days?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.overview(u.orgId, days ? Number(days) : 30)
  }
}
