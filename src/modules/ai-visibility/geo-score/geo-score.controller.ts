import { Controller, Get, Post, Delete, Body, Param, Query, BadRequestException, NotFoundException, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../../common/supabase'
import { ListingScraperService } from './services/listing-scraper.service'
import { GeoTelemetryService } from './services/geo-telemetry.service'
import { ScoreProcessorService } from './workers/score-processor.service'

interface ReqUserPayload { id: string; orgId: string }

const SORTABLE = new Set(['created_at', 'cost_usd', 'completed_at'])

/**
 * GEO Score — auditoria de visibilidade do listing nos motores de IA.
 * SupabaseAuthGuard por-controller (sem guard global). Tudo escopado por
 * org_id do JWT (as tabelas têm GRANT só service_role; isolamento na app).
 */
@Controller('ai-visibility')
@UseGuards(SupabaseAuthGuard)
export class GeoScoreController {
  constructor(
    private readonly scraper:   ListingScraperService,
    private readonly telemetry: GeoTelemetryService,
    private readonly processor: ScoreProcessorService,
  ) {}

  /** POST /ai-visibility/score — cria o job e dispara o processamento. */
  @Post('score')
  async createScore(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { url?: string },
    @Query('force') force?: string,
  ): Promise<{ jobId: string; status: string; cached: boolean }> {
    const url = (body?.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('Informe uma URL válida (começando com http/https).')
    }
    const platform = this.scraper.detectPlatform(url)
    const forceNew = force === 'true' || force === '1'

    // Cache 24h: reusa uma auditoria completed recente da mesma URL/org —
    // não cria job novo nem gasta tokens. ?force=true ignora o cache.
    if (!forceNew) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data: hit } = await supabaseAdmin
        .from('ai_audit_jobs')
        .select('id')
        .eq('org_id', user.orgId)
        .eq('url', url)
        .eq('status', 'completed')
        .is('deleted_at', null)
        .gte('completed_at', since)
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (hit) {
        const cachedId = (hit as { id: string }).id
        await this.telemetry.emit({
          orgId: user.orgId, userId: user.id, jobId: cachedId,
          eventName: 'geo_score.cache_hit',
          properties: { url, original_job_id: cachedId },
        })
        return { jobId: cachedId, status: 'completed', cached: true }
      }
    }

    const { data, error } = await supabaseAdmin
      .from('ai_audit_jobs')
      .insert({ org_id: user.orgId, url, platform, requested_by: user.id, status: 'pending' })
      .select('id')
      .single()
    if (error || !data) throw new BadRequestException(`Falha ao criar auditoria: ${error?.message ?? 'erro'}`)

    const jobId = (data as { id: string }).id
    if (forceNew) {
      await this.telemetry.emit({
        orgId: user.orgId, userId: user.id, jobId,
        eventName: 'geo_score.cache_bypassed',
        properties: { url, platform },
      })
    }
    await this.telemetry.emit({
      orgId: user.orgId, userId: user.id, jobId,
      eventName: 'geo_score.audit_queued',
      properties: { url, platform, source: 'api', cached: false },
    })
    this.processor.kick(jobId) // começa na hora; o cron é a rede de segurança

    return { jobId, status: 'pending', cached: false }
  }

  /** GET /ai-visibility/score/:jobId — status + resultado. */
  @Get('score/:jobId')
  async getScore(@ReqUser() user: ReqUserPayload, @Param('jobId') jobId: string) {
    const { data: job } = await supabaseAdmin
      .from('ai_audit_jobs')
      .select('id, url, platform, status, cost_usd, last_error, created_at, completed_at')
      .eq('id', jobId)
      .eq('org_id', user.orgId)
      .is('deleted_at', null)
      .maybeSingle()
    if (!job) throw new NotFoundException('Auditoria não encontrada.')

    const { data: result } = await supabaseAdmin
      .from('ai_audit_results')
      .select('geo_score, breakdown_json, recommendations_json')
      .eq('job_id', jobId)
      .maybeSingle()

    const j = job as Record<string, unknown>
    const r = result as Record<string, unknown> | null
    return {
      jobId:           j.id,
      url:             j.url,
      platform:        j.platform,
      status:          j.status,
      score:           r?.geo_score ?? null,
      breakdown:       r?.breakdown_json ?? null,
      recommendations: r?.recommendations_json ?? null,
      cost_usd:        j.cost_usd,
      error:           j.last_error ?? null,
      created_at:      j.created_at,
      completed_at:    j.completed_at,
    }
  }

  /** GET /ai-visibility/scores — lista paginada da org. */
  @Get('scores')
  async listScores(
    @ReqUser() user: ReqUserPayload,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort_by') sortBy?: string,
    @Query('filter_platform') filterPlatform?: string,
  ) {
    const p   = Math.max(1, parseInt(page ?? '1', 10) || 1)
    const lim = Math.min(100, Math.max(1, parseInt(limit ?? '20', 10) || 20))
    const sort = SORTABLE.has(sortBy ?? '') ? (sortBy as string) : 'created_at'
    const from = (p - 1) * lim

    let q = supabaseAdmin
      .from('ai_audit_jobs')
      .select('id, url, platform, status, cost_usd, created_at, completed_at', { count: 'exact' })
      .eq('org_id', user.orgId)
      .is('deleted_at', null)
    if (filterPlatform) q = q.eq('platform', filterPlatform)

    const { data, count } = await q.order(sort, { ascending: false }).range(from, from + lim - 1)
    return { items: data ?? [], page: p, limit: lim, total: count ?? 0 }
  }

  /** DELETE /ai-visibility/scores/:jobId — soft delete. */
  @Delete('scores/:jobId')
  async deleteScore(@ReqUser() user: ReqUserPayload, @Param('jobId') jobId: string): Promise<{ deleted: boolean }> {
    const { data } = await supabaseAdmin
      .from('ai_audit_jobs')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', jobId)
      .eq('org_id', user.orgId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()
    if (!data) throw new NotFoundException('Auditoria não encontrada.')
    return { deleted: true }
  }
}
