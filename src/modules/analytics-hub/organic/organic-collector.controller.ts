import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { OrganicCollectorService, type CollectSummary } from './organic-collector.service'
import { supabaseAdmin } from '../../../common/supabase'

interface ReqUserPayload { id: string; orgId: string }

/**
 * Analytics Hub — orgânico. Coleta sob demanda + listagem dos posts/reels
 * com métricas. Org vem do JWT; leitura backend-gated (service_role).
 */
@Controller('analytics/organic')
@UseGuards(SupabaseAuthGuard)
export class OrganicCollectorController {
  constructor(private readonly collector: OrganicCollectorService) {}

  /** POST /analytics/organic/collect — dispara a coleta do feed da org. */
  @Post('collect')
  collect(@ReqUser() user: ReqUserPayload): Promise<CollectSummary> {
    return this.collector.collectForOrg(user.orgId)
  }

  /** GET /analytics/organic/posts — lista posts com último snapshot. */
  @Get('posts')
  async posts(
    @ReqUser() user: ReqUserPayload,
    @Query('network') network?: string,
    @Query('account') account?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ posts: unknown[]; total: number }> {
    const lim = Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200)
    const off = Math.max(parseInt(offset ?? '0', 10) || 0, 0)

    let q = supabaseAdmin
      .from('analytics_social_posts')
      .select(
        'external_post_id, network, account_external_id, media_type, media_product_type, permalink, caption, thumbnail_url, published_at, source, latest_metrics, insights_available, last_fetched_at',
        { count: 'exact' },
      )
      .eq('organization_id', user.orgId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .range(off, off + lim - 1)
    if (network) q = q.eq('network', network)
    if (account) q = q.eq('account_external_id', account)

    const { data, count, error } = await q
    if (error) return { posts: [], total: 0 }
    return { posts: data ?? [], total: count ?? 0 }
  }
}
