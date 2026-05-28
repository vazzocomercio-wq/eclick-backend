import { Controller, Get, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { AnalyticsOverviewService } from './analytics-overview.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string }

/**
 * Analytics Hub — visão geral unificada. Resumo cross-rede pro painel.
 */
@Controller('analytics')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class AnalyticsOverviewController {
  constructor(private readonly overview: AnalyticsOverviewService) {}

  @Get('overview')
  @RequirePermission('orders.view')
  get(@ReqUser() user: ReqUserPayload): Promise<Record<string, unknown>> {
    return this.overview.getOverview(user.orgId)
  }
}
