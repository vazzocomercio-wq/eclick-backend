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

interface FullPostRow {
  id: string
  network: string
  account_external_id: string
  external_post_id: string
  media_type: string | null
  media_product_type: string | null
  permalink: string | null
  caption: string | null
  thumbnail_url: string | null
  media_url: string | null
  published_at: string | null
  source: string
  insights_available: boolean
  latest_metrics: Record<string, number> | null
}

// ─── Drill-down por post (TR-A) ─────────────────────────────────
export interface OrganicPostMetrics {
  reach: number
  views: number
  likes: number
  comments: number
  shares: number
  saved: number
  impressions: number
  total_interactions: number
  engagement_rate: number
}
export interface OrganicPostItem {
  id: string
  network: string
  account_external_id: string
  external_post_id: string
  media_type: string | null
  media_product_type: string | null
  permalink: string | null
  caption: string
  thumbnail_url: string | null
  media_url: string | null
  published_at: string | null
  source: string
  insights_available: boolean
  metrics: OrganicPostMetrics
  score: number
}
export interface OrganicPostsPage {
  posts: OrganicPostItem[]
  total: number
}
export interface OrganicPostDailyPoint {
  date: string
  reach: number
  impressions: number
  likes: number
  comments: number
  shares: number
  saved: number
  video_views: number
  total_interactions: number
  engagement_rate: number
}
export interface OrganicPostDetail {
  post: OrganicPostItem
  daily: OrganicPostDailyPoint[]
  benchmark: {
    format: string
    median_reach: number
    median_engagement_rate: number
    sample: number
  } | null
}
export interface OrganicPostsFilters {
  format?: string
  network?: string
  account?: string
  search?: string
  sort?: 'reach' | 'engagement' | 'recent' | 'score'
  limit?: number
  offset?: number
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

  // ─── Drill-down: lista de posts (TR-A) ────────────────────────────────────
  /**
   * Lista TODOS os posts da org com métricas individuais + score relativo
   * estável (calculado sobre o conjunto inteiro, não muda com filtro). Filtros
   * e ordenação são em memória (≤500 posts/org).
   */
  async listOrganicPosts(orgId: string, f: OrganicPostsFilters = {}): Promise<OrganicPostsPage> {
    const { data } = await supabaseAdmin
      .from('analytics_social_posts')
      .select('id, network, account_external_id, external_post_id, media_type, media_product_type, permalink, caption, thumbnail_url, media_url, published_at, source, insights_available, latest_metrics')
      .eq('organization_id', orgId)
      .limit(500)
    const all = (data ?? []) as FullPostRow[]

    // máximos globais → score estável independente do filtro
    const maxReach = Math.max(...all.map((r) => r.latest_metrics?.reach ?? 0), 1)
    const maxEr = Math.max(...all.map((r) => r.latest_metrics?.engagement_rate ?? 0), 0.0001)

    let rows = all
    if (f.format) rows = rows.filter((r) => (r.media_product_type ?? 'OUTRO') === f.format)
    if (f.network) rows = rows.filter((r) => r.network === f.network)
    if (f.account) rows = rows.filter((r) => r.account_external_id === f.account)
    if (f.search) {
      const s = f.search.toLowerCase()
      rows = rows.filter((r) => (r.caption ?? '').toLowerCase().includes(s))
    }
    const total = rows.length

    const score = (r: FullPostRow) => this.scoreOf(r.latest_metrics?.reach ?? 0, r.latest_metrics?.engagement_rate ?? 0, maxReach, maxEr)
    const sort = f.sort ?? 'reach'
    rows = [...rows].sort((a, b) => {
      if (sort === 'recent') return (new Date(b.published_at ?? 0).getTime()) - (new Date(a.published_at ?? 0).getTime())
      if (sort === 'engagement') return (b.latest_metrics?.engagement_rate ?? 0) - (a.latest_metrics?.engagement_rate ?? 0)
      if (sort === 'score') return score(b) - score(a)
      return (b.latest_metrics?.reach ?? 0) - (a.latest_metrics?.reach ?? 0)
    })

    const offset = Math.max(f.offset ?? 0, 0)
    const limit = Math.min(f.limit ?? 50, 200)
    const page = rows.slice(offset, offset + limit)
    return { posts: page.map((r) => this.toPostItem(r, score(r))), total }
  }

  /** Detalhe de 1 post: métricas + série diária + benchmark (mediana do formato). */
  async getOrganicPostDetail(orgId: string, postId: string): Promise<OrganicPostDetail | null> {
    const { data: post } = await supabaseAdmin
      .from('analytics_social_posts')
      .select('id, network, account_external_id, external_post_id, media_type, media_product_type, permalink, caption, thumbnail_url, media_url, published_at, source, insights_available, latest_metrics')
      .eq('organization_id', orgId)
      .eq('id', postId)
      .maybeSingle()
    if (!post) return null
    const p = post as FullPostRow

    const [{ data: dailyData }, { data: peersData }] = await Promise.all([
      supabaseAdmin
        .from('analytics_social_metrics_daily')
        .select('date, reach, impressions, likes, comments, shares, saved, video_views, total_interactions, engagement_rate')
        .eq('organization_id', orgId)
        .eq('post_id', postId)
        .order('date', { ascending: true })
        .limit(180),
      supabaseAdmin
        .from('analytics_social_posts')
        .select('media_product_type, latest_metrics')
        .eq('organization_id', orgId)
        .limit(500),
    ])

    const daily = (dailyData ?? []) as OrganicPostDailyPoint[]

    // benchmark: mediana de alcance/engajamento dos posts do MESMO formato
    const fmt = p.media_product_type ?? 'OUTRO'
    const peers = ((peersData ?? []) as Array<{ media_product_type: string | null; latest_metrics: Record<string, number> | null }>)
      .filter((x) => (x.media_product_type ?? 'OUTRO') === fmt)
    const benchmark = peers.length
      ? {
          format: fmt,
          median_reach: this.median(peers.map((x) => x.latest_metrics?.reach ?? 0)),
          median_engagement_rate: this.median(peers.map((x) => x.latest_metrics?.engagement_rate ?? 0)),
          sample: peers.length,
        }
      : null

    return { post: this.toPostItem(p, 0), daily, benchmark }
  }

  private toPostItem(r: FullPostRow, score: number): OrganicPostItem {
    const m = r.latest_metrics ?? {}
    return {
      id: r.id,
      network: r.network,
      account_external_id: r.account_external_id,
      external_post_id: r.external_post_id,
      media_type: r.media_type,
      media_product_type: r.media_product_type,
      permalink: r.permalink,
      caption: r.caption ?? '',
      thumbnail_url: r.thumbnail_url,
      media_url: r.media_url,
      published_at: r.published_at,
      source: r.source,
      insights_available: r.insights_available,
      metrics: {
        reach: m.reach ?? 0,
        views: m.video_views ?? 0,
        likes: m.likes ?? 0,
        comments: m.comments ?? 0,
        shares: m.shares ?? 0,
        saved: m.saved ?? 0,
        impressions: m.impressions ?? 0,
        total_interactions: m.total_interactions ?? 0,
        engagement_rate: m.engagement_rate ?? 0,
      },
      score,
    }
  }

  private scoreOf(reach: number, er: number, maxReach: number, maxEr: number): number {
    const r = maxReach > 0 ? reach / maxReach : 0
    const e = maxEr > 0 ? er / maxEr : 0
    return Math.round((0.45 * r + 0.55 * e) * 100)
  }

  private median(nums: number[]): number {
    if (!nums.length) return 0
    const s = [...nums].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
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
