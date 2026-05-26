import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`
const MAX_MEDIA = 200 // teto de posts por conta por coleta (paginado)

interface IgChannelRow {
  organization_id: string
  access_token: string | null
  config: Record<string, unknown> | null
}

interface IgMedia {
  id: string
  media_type?: string
  media_product_type?: string
  permalink?: string
  caption?: string
  thumbnail_url?: string
  media_url?: string
  timestamp?: string
  like_count?: number
  comments_count?: number
}

export interface CollectSummary {
  accounts: number
  posts: number
  with_insights: number
  without_insights: number
  errors: string[]
}

interface PostInsights {
  reach: number
  impressions: number
  saved: number
  shares: number
  video_views: number
  total_interactions: number
  available: boolean
  raw: Record<string, unknown>
}

/**
 * Coletor orgânico do Analytics Hub. O SaaS usa o PRÓPRIO token Meta
 * (social_commerce_channels.access_token) pra puxar TODO o feed de cada
 * conta IG da org — não depende do Active. Multi-conta nativo.
 *
 * likes/comments vêm do nó da mídia (precisa só instagram_basic).
 * reach/saved/shares/views vêm de /{media}/insights (precisa
 * instagram_manage_insights — adicionado no OAuth em F0; ativa no re-OAuth).
 * Sem o scope, o post é gravado mesmo assim com insights_available=false.
 */
@Injectable()
export class OrganicCollectorService {
  private readonly logger = new Logger(OrganicCollectorService.name)

  /** Coleta o feed de todas as contas IG conectadas da org. */
  async collectForOrg(orgId: string): Promise<CollectSummary> {
    const summary: CollectSummary = { accounts: 0, posts: 0, with_insights: 0, without_insights: 0, errors: [] }

    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('organization_id, access_token, config')
      .eq('organization_id', orgId)
      .eq('channel', 'instagram_shop')
    if (error) {
      summary.errors.push(`canais: ${error.message}`)
      return summary
    }

    const channels = (data ?? []) as IgChannelRow[]
    for (const ch of channels) {
      const igUserId = (ch.config?.instagram_account_id as string | undefined) ?? null
      const token = ch.access_token
      if (!igUserId || !token) {
        summary.errors.push('conta IG sem instagram_account_id ou token')
        continue
      }
      summary.accounts++
      try {
        await this.collectAccount(orgId, igUserId, token, summary)
      } catch (err) {
        summary.errors.push(`conta ${igUserId}: ${String(err)}`)
      }
    }
    return summary
  }

  /** Coleta o feed de UMA conta IG (paginado, até MAX_MEDIA). */
  private async collectAccount(
    orgId: string,
    igUserId: string,
    token: string,
    summary: CollectSummary,
  ): Promise<void> {
    const fields =
      'id,media_type,media_product_type,permalink,caption,thumbnail_url,media_url,timestamp,like_count,comments_count'
    let url: string | null =
      `${GRAPH_BASE}/${igUserId}/media?fields=${fields}&limit=50&access_token=${encodeURIComponent(token)}`
    let fetched = 0
    const today = new Date().toISOString().slice(0, 10)

    while (url && fetched < MAX_MEDIA) {
      const res = await fetch(url)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`media ${res.status}: ${text.slice(0, 160)}`)
      }
      const body = (await res.json()) as { data?: IgMedia[]; paging?: { next?: string } }
      const items = body.data ?? []

      for (const m of items) {
        fetched++
        const likes = m.like_count ?? 0
        const comments = m.comments_count ?? 0
        const ins = await this.fetchInsights(m.id, m.media_product_type, token)

        const engagementSum = likes + comments + ins.shares + ins.saved
        const engagementRate = ins.reach > 0 ? engagementSum / ins.reach : 0
        const metrics = {
          reach: ins.reach,
          impressions: ins.impressions,
          likes,
          comments,
          shares: ins.shares,
          saved: ins.saved,
          video_views: ins.video_views,
          total_interactions: ins.total_interactions || engagementSum,
          engagement_rate: engagementRate,
        }

        // upsert do post (catálogo + último snapshot)
        const { data: postRow, error: upErr } = await supabaseAdmin
          .from('analytics_social_posts')
          .upsert(
            {
              organization_id: orgId,
              network: 'instagram',
              account_external_id: igUserId,
              external_post_id: m.id,
              media_type: m.media_type ?? null,
              media_product_type: m.media_product_type ?? null,
              permalink: m.permalink ?? null,
              caption: m.caption ?? null,
              thumbnail_url: m.thumbnail_url ?? m.media_url ?? null,
              media_url: m.media_url ?? null,
              published_at: m.timestamp ?? null,
              latest_metrics: metrics,
              insights_available: ins.available,
              last_fetched_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'organization_id,account_external_id,external_post_id' },
          )
          .select('id')
          .single()

        if (upErr || !postRow) {
          summary.errors.push(`post ${m.id}: ${upErr?.message ?? 'sem id'}`)
          continue
        }
        summary.posts++
        if (ins.available) summary.with_insights++
        else summary.without_insights++

        // snapshot diário
        const { error: mErr } = await supabaseAdmin
          .from('analytics_social_metrics_daily')
          .upsert(
            {
              organization_id: orgId,
              post_id: (postRow as { id: string }).id,
              network: 'instagram',
              account_external_id: igUserId,
              external_post_id: m.id,
              date: today,
              reach: ins.reach,
              impressions: ins.impressions,
              likes,
              comments,
              shares: ins.shares,
              saved: ins.saved,
              video_views: ins.video_views,
              total_interactions: metrics.total_interactions,
              engagement_rate: engagementRate,
              raw_metrics: ins.raw,
              fetched_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'post_id,date' },
          )
        if (mErr) summary.errors.push(`metrics ${m.id}: ${mErr.message}`)
      }

      url = body.paging?.next ?? null
    }
  }

  /**
   * Busca insights de UMA mídia. Tolerante: se o scope
   * instagram_manage_insights não estiver no token, a Graph retorna erro →
   * devolvemos available=false (likes/comments já vieram do nó da mídia).
   * Nomes de métrica variam por tipo de mídia (reels usa 'views'); pedimos
   * um conjunto base e parseamos o que voltar.
   */
  private async fetchInsights(
    mediaId: string,
    productType: string | undefined,
    token: string,
  ): Promise<PostInsights> {
    const empty: PostInsights = {
      reach: 0, impressions: 0, saved: 0, shares: 0,
      video_views: 0, total_interactions: 0, available: false, raw: {},
    }

    const isReel = productType === 'REELS'
    const metrics = isReel
      ? ['reach', 'saved', 'shares', 'total_interactions', 'views']
      : ['reach', 'saved', 'shares', 'total_interactions']

    const url =
      `${GRAPH_BASE}/${mediaId}/insights?metric=${metrics.join(',')}&access_token=${encodeURIComponent(token)}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        // 400 típico = falta scope OU métrica inválida pro tipo. Não é fatal.
        return empty
      }
      const body = (await res.json()) as {
        data?: { name: string; values?: { value?: number }[] }[]
      }
      const rows = body.data ?? []
      const get = (name: string): number => {
        const r = rows.find((x) => x.name === name)
        const v = r?.values?.[0]?.value
        return typeof v === 'number' ? v : 0
      }
      return {
        reach: get('reach'),
        impressions: get('impressions'),
        saved: get('saved'),
        shares: get('shares'),
        video_views: get('views') || get('video_views'),
        total_interactions: get('total_interactions'),
        available: rows.length > 0,
        raw: { data: rows, fetched_at: new Date().toISOString() },
      }
    } catch {
      return empty
    }
  }

  /** Enumera todas as orgs com canal IG conectado (pro worker cross-org). */
  async orgsWithInstagram(): Promise<string[]> {
    const { data, error } = await supabaseAdmin
      .from('social_commerce_channels')
      .select('organization_id')
      .eq('channel', 'instagram_shop')
      .eq('status', 'connected')
    if (error) {
      this.logger.warn(`[organic] orgsWithInstagram falhou: ${error.message}`)
      return []
    }
    const set = new Set<string>()
    for (const r of (data ?? []) as { organization_id: string }[]) set.add(r.organization_id)
    return [...set]
  }
}
