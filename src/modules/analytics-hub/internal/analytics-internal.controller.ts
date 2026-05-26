import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common'
import { InternalKeyGuard } from '../../internal/internal-key.guard'
import { AnalyticsOverviewService } from '../overview/analytics-overview.service'

/**
 * Endpoints internos do Analytics Hub (X-Internal-Key) — consumidos pelo Active
 * via bridge. Expõe o resumo orgânico coletado no SaaS pro Social Intelligence.
 */
@Controller('internal/analytics')
@UseGuards(InternalKeyGuard)
export class AnalyticsInternalController {
  constructor(private readonly overview: AnalyticsOverviewService) {}

  @Get('organic-summary')
  organicSummary(@Query('org_id') orgId: string) {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    return this.overview.getOrganicSummary(orgId)
  }
}
