import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { GeoRadarService, type RadarEngine, type RadarRunSummary } from './geo-radar.service'
import { supabaseAdmin } from '../../../common/supabase'

interface ReqUserPayload { id: string; orgId: string }

/**
 * Analytics Hub — GEO Radar. Semeia queries, roda a medição de presença em IA
 * (gasta créditos) e expõe o resumo. Org do JWT; leitura backend-gated.
 */
@Controller('analytics/geo-radar')
@UseGuards(SupabaseAuthGuard)
export class GeoRadarController {
  constructor(private readonly radar: GeoRadarService) {}

  /** POST /analytics/geo-radar/seed — gera queries do catálogo + alvos. */
  @Post('seed')
  seed(@ReqUser() user: ReqUserPayload): Promise<{ queries: number; products: number }> {
    return this.radar.seed(user.orgId)
  }

  /** POST /analytics/geo-radar/run — roda a medição (CUSTA créditos). */
  @Post('run')
  run(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { maxQueries?: number; engines?: RadarEngine[]; maxCostUsd?: number },
  ): Promise<RadarRunSummary> {
    return this.radar.run(user.orgId, body)
  }

  /** GET /analytics/geo-radar — resumo da última medição. */
  @Get()
  async summary(@ReqUser() user: ReqUserPayload): Promise<{
    latest_date: string | null
    by_engine: Record<string, { runs: number; mentioned: number; mention_rate: number }>
    rows: unknown[]
  }> {
    const { data } = await supabaseAdmin
      .from('analytics_geo_radar_runs')
      .select('query, engine, date, mentioned, brand_cited, position, answer_excerpt, citations')
      .eq('organization_id', user.orgId)
      .order('date', { ascending: false })
      .limit(200)
    const rows = (data ?? []) as { engine: string; date: string; mentioned: boolean }[]
    const latest = rows[0]?.date ?? null
    const latestRows = rows.filter((r) => r.date === latest)
    const by: Record<string, { runs: number; mentioned: number; mention_rate: number }> = {}
    for (const r of latestRows) {
      const b = (by[r.engine] ??= { runs: 0, mentioned: 0, mention_rate: 0 })
      b.runs++
      if (r.mentioned) b.mentioned++
    }
    for (const e of Object.keys(by)) by[e].mention_rate = by[e].runs ? by[e].mentioned / by[e].runs : 0
    return { latest_date: latest, by_engine: by, rows: latestRows }
  }
}
