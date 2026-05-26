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

  /**
   * Resumo orgânico COMPLETO pro bridge (Active Social Intelligence):
   * totais + por formato + heatmap dia×hora (BRT) + tendência + top posts +
   * best_format/best_hour. Alimenta o dashboard executivo e o cérebro do Active.
   */
  async getOrganicSummary(orgId: string) {
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
    const [postsRes, acctRes, dailyRes] = await Promise.all([
      supabaseAdmin
        .from('analytics_social_posts')
        .select('permalink, caption, media_product_type, thumbnail_url, published_at, latest_metrics')
        .eq('organization_id', orgId).limit(500),
      supabaseAdmin
        .from('analytics_account_metrics_daily')
        .select('followers_count, reach, profile_views, date')
        .eq('organization_id', orgId).order('date', { ascending: false }).limit(1),
      supabaseAdmin
        .from('analytics_social_metrics_daily')
        .select('date, reach, video_views')
        .eq('organization_id', orgId).gte('date', since)
        .order('date', { ascending: true }).limit(2000),
    ])

    const posts = (postsRes.data ?? []) as PostRow[]
    let reach = 0, views = 0, eng = 0, erSum = 0, erCount = 0
    const fmt = new Map<string, { posts: number; reach: number; erSum: number; erCount: number }>()
    const heat = new Map<string, { posts: number; reach: number }>()
    for (const p of posts) {
      const m = p.latest_metrics ?? {}
      const r = m.reach ?? 0
      reach += r
      views += m.video_views ?? 0
      eng += (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saved ?? 0)
      if (r > 0) { erSum += m.engagement_rate ?? 0; erCount++ }
      const f = p.media_product_type ?? 'OUTRO'
      const fe = fmt.get(f) ?? { posts: 0, reach: 0, erSum: 0, erCount: 0 }
      fe.posts++; fe.reach += r
      if (r > 0) { fe.erSum += m.engagement_rate ?? 0; fe.erCount++ }
      fmt.set(f, fe)
      if (p.published_at) {
        const brt = new Date(new Date(p.published_at).getTime() - 3 * 3600000) // UTC→BRT
        const key = `${brt.getUTCDay()}-${brt.getUTCHours()}`
        const he = heat.get(key) ?? { posts: 0, reach: 0 }
        he.posts++; he.reach += r
        heat.set(key, he)
      }
    }

    const by_format = [...fmt.entries()]
      .map(([format, v]) => ({ format, posts: v.posts, avg_reach: v.posts ? Math.round(v.reach / v.posts) : 0, avg_engagement_rate: v.erCount ? v.erSum / v.erCount : 0 }))
      .sort((a, b) => b.avg_engagement_rate - a.avg_engagement_rate)
    const heatmap = [...heat.entries()].map(([k, v]) => {
      const [dow, hour] = k.split('-').map(Number)
      return { dow, hour, posts: v.posts, reach: v.reach }
    })
    const top_posts = [...posts]
      .sort((a, b) => (b.latest_metrics?.reach ?? 0) - (a.latest_metrics?.reach ?? 0))
      .slice(0, 5)
      .map((p) => ({ permalink: p.permalink, caption: (p.caption ?? '').slice(0, 80), type: p.media_product_type, thumbnail_url: p.thumbnail_url, reach: p.latest_metrics?.reach ?? 0, views: p.latest_metrics?.video_views ?? 0, engagement_rate: p.latest_metrics?.engagement_rate ?? 0 }))
    const acct = (acctRes.data?.[0] as { followers_count?: number; reach?: number; profile_views?: number } | undefined) ?? null
    const trend = ((dailyRes.data ?? []) as { date: string; reach: number; video_views: number }[])
      .reduce<Array<{ date: string; reach: number; views: number }>>((acc, r) => {
        const e = acc.find((x) => x.date === r.date)
        if (e) { e.reach += r.reach; e.views += r.video_views } else acc.push({ date: r.date, reach: r.reach, views: r.video_views })
        return acc
      }, [])

    const best_hour = heatmap.length ? [...heatmap].sort((a, b) => b.reach - a.reach)[0].hour : null
    return {
      totals: { posts: posts.length, reach, views, engagement: eng, avg_engagement_rate: erCount ? erSum / erCount : 0, followers: acct?.followers_count ?? 0, profile_views: acct?.profile_views ?? 0 },
      by_format,
      heatmap,
      top_posts,
      trend,
      best_format: by_format[0]?.format ?? null,
      best_hour,
    }
  }

  async getOverview(orgId: string) {
    const [accounts, organic, geo, geoRadar] = await Promise.all([
      this.accounts.listAccounts(orgId),
      this.organicSummary(orgId),
      this.geoSummary(orgId),
      this.geoRadarSummary(orgId),
    ])

    const byNetwork: Record<string, number> = {}
    for (const a of accounts) byNetwork[a.network] = (byNetwork[a.network] ?? 0) + 1

    return {
      accounts: { total: accounts.length, by_network: byNetwork, list: accounts },
      organic,
      geo,
      geo_radar: geoRadar,
      paid: { connected: false, note: 'Nenhuma conta de anúncios conectada' },
      generated_at: new Date().toISOString(),
    }
  }

  // ── GEO Radar: share-of-voice em IA (última medição) ──────────────────────
  private async geoRadarSummary(orgId: string) {
    const { data } = await supabaseAdmin
      .from('analytics_geo_radar_runs')
      .select('engine, date, mentioned')
      .eq('organization_id', orgId)
      .order('date', { ascending: false })
      .limit(300)
    const rows = (data ?? []) as { engine: string; date: string; mentioned: boolean }[]
    const latest = rows[0]?.date ?? null
    const latestRows = rows.filter((r) => r.date === latest)
    const byEngine: Record<string, { runs: number; mentioned: number; mention_rate: number }> = {}
    for (const r of latestRows) {
      const b = (byEngine[r.engine] ??= { runs: 0, mentioned: 0, mention_rate: 0 })
      b.runs++
      if (r.mentioned) b.mentioned++
    }
    for (const e of Object.keys(byEngine)) byEngine[e].mention_rate = byEngine[e].runs ? byEngine[e].mentioned / byEngine[e].runs : 0
    const totalRuns = latestRows.length
    const totalMentioned = latestRows.filter((r) => r.mentioned).length
    const engineCount = Math.max(Object.keys(byEngine).length, 1)
    return {
      latest_date: latest,
      queries_measured: Math.round(totalRuns / engineCount),
      share_of_voice: totalRuns ? totalMentioned / totalRuns : 0,
      by_engine: byEngine,
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
