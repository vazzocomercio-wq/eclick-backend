import { Controller, Get, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { AnalyticsOverviewService } from './analytics-overview.service'

interface ReqUserPayload { id: string; orgId: string }

/**
 * Analytics Hub — visão geral unificada. Resumo cross-rede pro painel.
 */
@Controller('analytics')
@UseGuards(SupabaseAuthGuard)
export class AnalyticsOverviewController {
  constructor(private readonly overview: AnalyticsOverviewService) {}

  @Get('overview')
  get(@ReqUser() user: ReqUserPayload): Promise<Record<string, unknown>> {
    return this.overview.getOverview(user.orgId)
  }
}
