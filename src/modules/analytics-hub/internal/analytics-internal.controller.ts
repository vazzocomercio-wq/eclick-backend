import { BadRequestException, Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common'
import { InternalKeyGuard } from '../../internal/internal-key.guard'
import {
  AnalyticsOverviewService,
  type OrganicPostDetail,
  type OrganicPostsFilters,
  type OrganicPostsPage,
} from '../overview/analytics-overview.service'

/**
 * Endpoints internos do Analytics Hub (X-Internal-Key) — consumidos pelo Active
 * via bridge. Expõe o resumo orgânico + drill-down por post pro Social Intelligence.
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

  /** Lista de posts da org com métricas individuais + score (drill-down TR-A). */
  @Get('posts')
  posts(
    @Query('org_id') orgId: string,
    @Query('format') format?: string,
    @Query('network') network?: string,
    @Query('account') account?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<OrganicPostsPage> {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    const filters: OrganicPostsFilters = {
      format,
      network,
      account,
      search,
      sort: (['reach', 'engagement', 'recent', 'score'] as const).includes(sort as never)
        ? (sort as OrganicPostsFilters['sort'])
        : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    }
    return this.overview.listOrganicPosts(orgId, filters)
  }

  /** Detalhe de 1 post (métricas + série diária + benchmark do formato). */
  @Get('posts/:id')
  async post(
    @Query('org_id') orgId: string,
    @Param('id') id: string,
  ): Promise<OrganicPostDetail> {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    const detail = await this.overview.getOrganicPostDetail(orgId, id)
    if (!detail) throw new NotFoundException('Post não encontrado')
    return detail
  }
}
