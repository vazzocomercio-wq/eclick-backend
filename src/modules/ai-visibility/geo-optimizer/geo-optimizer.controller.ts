import { Controller, Post, Get, Body, Param, Query, BadRequestException, NotFoundException, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../../common/supabase'
import { ListingScraperService } from '../geo-score/services/listing-scraper.service'
import { GeoTelemetryService } from '../geo-score/services/geo-telemetry.service'
import { GeoDimensionResult } from '../shared/types'
import { GeoSkipError } from '../shared/skip-error'
import { TitleRewriterService } from './services/title-rewriter.service'
import { DescriptionBuilderService } from './services/description-builder.service'
import { MlPublisherService } from './services/ml-publisher.service'

interface ReqUserPayload { id: string; orgId: string }

/**
 * GEO Optimizer (Sprint 2). Dia 10: gera RASCUNHOS (títulos A/B/C + descrição
 * reescrita) — NÃO publica no marketplace. Apply/rollback/A-B vêm no Dia 12.
 * SupabaseAuthGuard por-controller; tudo escopado por org do JWT.
 */
@Controller('ai-visibility')
@UseGuards(SupabaseAuthGuard)
export class GeoOptimizerController {
  constructor(
    private readonly scraper:      ListingScraperService,
    private readonly titles:       TitleRewriterService,
    private readonly descriptions: DescriptionBuilderService,
    private readonly publisher:    MlPublisherService,
    private readonly telemetry:    GeoTelemetryService,
  ) {}

  /** POST /ai-visibility/optimize — gera o rascunho de otimização. */
  @Post('optimize')
  async optimize(@ReqUser() user: ReqUserPayload, @Body() body: { url?: string }) {
    const url = (body?.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('Informe uma URL válida (http/https).')

    let scraped
    try {
      scraped = await this.scraper.scrape(url, user.orgId)
    } catch (e) {
      if (e instanceof GeoSkipError) throw new BadRequestException('Anúncio indisponível (esgotado/pausado/inexistente) — não dá pra otimizar.')
      throw e
    }

    // Reusa o breakdown da última auditoria completed desta URL (se houver).
    let jobId: string | null = null
    let breakdown: GeoDimensionResult[] | null = null
    const { data: job } = await supabaseAdmin
      .from('ai_audit_jobs')
      .select('id')
      .eq('org_id', user.orgId).eq('url', url).eq('status', 'completed').is('deleted_at', null)
      .order('completed_at', { ascending: false }).limit(1).maybeSingle()
    if (job) {
      jobId = (job as { id: string }).id
      const { data: res } = await supabaseAdmin
        .from('ai_audit_results').select('breakdown_json').eq('job_id', jobId).maybeSingle()
      const bd = (res as { breakdown_json?: unknown } | null)?.breakdown_json
      breakdown = Array.isArray(bd) ? (bd as GeoDimensionResult[]) : null
    }

    const titles = await this.titles.generate(user.orgId, scraped, breakdown)
    const desc   = await this.descriptions.build(user.orgId, scraped, breakdown)
    const costUsd = +(titles.costUsd + desc.costUsd).toFixed(6)

    const { data, error } = await supabaseAdmin
      .from('ai_optimizer_results')
      .insert({
        org_id:           user.orgId,
        job_id:           jobId,
        url,
        platform:         scraped.platform,
        title_variations: titles.variations,
        description_old:  scraped.description,
        description_new:  desc.description,
        status:           'draft',
        cost_usd:         costUsd,
      })
      .select('id')
      .single()
    if (error || !data) throw new BadRequestException(`Falha ao salvar otimização: ${error?.message ?? 'erro'}`)
    const optimizerId = (data as { id: string }).id

    await this.telemetry.emit({
      orgId: user.orgId, userId: user.id, jobId: optimizerId, feature: 'geo_optimizer',
      eventName: 'geo_optimizer.generation_requested', properties: { url, platform: scraped.platform },
    })

    return {
      optimizerId,
      status:           'draft',
      title_variations: titles.variations,
      description_old:  scraped.description,
      description_new:  desc.description,
      cost_usd:         costUsd,
    }
  }

  /** GET /ai-visibility/optimize/:optimizerId — rascunho + status. */
  @Get('optimize/:optimizerId')
  async getOptimization(@ReqUser() user: ReqUserPayload, @Param('optimizerId') optimizerId: string) {
    const { data } = await supabaseAdmin
      .from('ai_optimizer_results')
      .select('id, url, platform, title_variations, description_old, description_new, faq_generated, schema_jsonld, status, cost_usd, applied_at, rolled_back_at, created_at')
      .eq('id', optimizerId).eq('org_id', user.orgId).maybeSingle()
    if (!data) throw new NotFoundException('Otimização não encontrada.')
    return data
  }

  /**
   * POST /ai-visibility/optimize/:optimizerId/apply — PUBLICA no marketplace.
   * ALTO RISCO. Salvaguardas no MlPublisherService (cap diário, versão, baseline).
   * ?confirm_batch_expansion=true libera além do cap de 5/dia.
   */
  @Post('optimize/:optimizerId/apply')
  async apply(
    @ReqUser() user: ReqUserPayload,
    @Param('optimizerId') optimizerId: string,
    @Body() body: { variant?: 'A' | 'B' | 'C' },
    @Query('confirm_batch_expansion') confirmBatch?: string,
  ) {
    const variant = body?.variant
    if (!['A', 'B', 'C'].includes(variant ?? '')) throw new BadRequestException('Escolha a variação A, B ou C.')
    await this.telemetry.emit({
      orgId: user.orgId, userId: user.id, jobId: optimizerId, feature: 'geo_optimizer',
      eventName: 'geo_optimizer.variation_selected', properties: { optimizer_id: optimizerId, variant },
    })
    return this.publisher.apply({
      orgId: user.orgId, userId: user.id, optimizerId, variant: variant as 'A' | 'B' | 'C',
      confirmBatchExpansion: confirmBatch === 'true' || confirmBatch === '1',
    })
  }

  /** POST /ai-visibility/optimize/:optimizerId/rollback — volta o anúncio ao original. */
  @Post('optimize/:optimizerId/rollback')
  async rollback(
    @ReqUser() user: ReqUserPayload,
    @Param('optimizerId') optimizerId: string,
    @Body() body: { reason?: string },
  ) {
    return this.publisher.rollback({ orgId: user.orgId, userId: user.id, optimizerId, reason: body?.reason })
  }
}
