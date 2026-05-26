import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { AnalyticsAccountsService } from '../accounts/analytics-accounts.service'

interface PostRow {
  permalink: string | null
  caption: string | null
  media_product_type: string | null
  thumbnail_url: string | null
  published_at: string | null
  latest_metrics: Record<string, number> | null
}

interface AccountMetricRow {
  account_external_id: string
  date: string
  followers_count: number
  follows_count: number
  reach: number
  profile_views: number
  accounts_engaged: number
}

/**
 * Agregador do Analytics Hub. Cruza TODAS as superfícies da org num resumo
 * único pro painel: contas conectadas (multi-rede) + orgânico (IG) + GEO
 * (visibilidade em IA) + pago (placeholder até conectar). Marketplace e o
 * pago do Active entram nas próximas iterações (via bridge).
 */
@Injectable()
export class AnalyticsOverviewService {
  constructor(private readonly accounts: AnalyticsAccountsService) {}

  async getOverview(orgId: string) {
    const [accounts, organic, geo] = await Promise.all([
      this.accounts.listAccounts(orgId),
      this.organicSummary(orgId),
      this.geoSummary(orgId),
    ])

    const byNetwork: Record<string, number> = {}
    for (const a of accounts) byNetwork[a.network] = (byNetwork[a.network] ?? 0) + 1

    return {
      accounts: { total: accounts.length, by_network: byNetwork, list: accounts },
      organic,
      geo,
      paid: { connected: false, note: 'Nenhuma conta de anúncios conectada' },
      generated_at: new Date().toISOString(),
    }
  }

  // ── Orgânico (IG): agrega posts + última métrica de conta ─────────────────
  private async organicSummary(orgId: string) {
    const { data: posts } = await supabaseAdmin
      .from('analytics_social_posts')
      .select('permalink, caption, media_product_type, thumbnail_url, published_at, latest_metrics')
      .eq('organization_id', orgId)
      .limit(500)

    const rows = (posts ?? []) as PostRow[]
    let totalReach = 0, totalViews = 0, totalEngagement = 0, erSum = 0, erCount = 0
    for (const p of rows) {
      const m = p.latest_metrics ?? {}
      totalReach += m.reach ?? 0
      totalViews += m.video_views ?? 0
      totalEngagement += (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saved ?? 0)
      if ((m.reach ?? 0) > 0) { erSum += m.engagement_rate ?? 0; erCount++ }
    }
    const topPosts = [...rows]
      .sort((a, b) => (b.latest_metrics?.reach ?? 0) - (a.latest_metrics?.reach ?? 0))
      .slice(0, 5)
      .map((p) => ({
        permalink: p.permalink,
        caption: (p.caption ?? '').slice(0, 80),
        type: p.media_product_type,
        thumbnail_url: p.thumbnail_url,
        published_at: p.published_at,
        reach: p.latest_metrics?.reach ?? 0,
        views: p.latest_metrics?.video_views ?? 0,
        engagement_rate: p.latest_metrics?.engagement_rate ?? 0,
      }))

    const { data: acct } = await supabaseAdmin
      .from('analytics_account_metrics_daily')
      .select('account_external_id, date, followers_count, follows_count, reach, profile_views, accounts_engaged')
      .eq('organization_id', orgId)
      .order('date', { ascending: false })
      .limit(1)
    const latestAccount = (acct?.[0] as AccountMetricRow | undefined) ?? null

    return {
      posts_count: rows.length,
      total_reach: totalReach,
      total_views: totalViews,
      total_engagement: totalEngagement,
      avg_engagement_rate: erCount > 0 ? erSum / erCount : 0,
      top_posts: topPosts,
      account: latestAccount,
    }
  }

  // ── GEO (visibilidade em IA): resume os audits ────────────────────────────
  private async geoSummary(orgId: string) {
    const { data } = await supabaseAdmin
      .from('ai_audit_results')
      .select('geo_score')
      .eq('org_id', orgId)
      .not('geo_score', 'is', null)
      .limit(2000)

    const scores = ((data ?? []) as { geo_score: number }[]).map((r) => r.geo_score)
    const n = scores.length
    const avg = n > 0 ? scores.reduce((s, v) => s + v, 0) / n : 0
    const dist = { critico_0_30: 0, fraco_31_60: 0, bom_61_80: 0, otimo_81_100: 0 }
    for (const s of scores) {
      if (s <= 30) dist.critico_0_30++
      else if (s <= 60) dist.fraco_31_60++
      else if (s <= 80) dist.bom_61_80++
      else dist.otimo_81_100++
    }
    return { audits: n, avg_score: Math.round(avg * 10) / 10, distribution: dist }
  }
}
