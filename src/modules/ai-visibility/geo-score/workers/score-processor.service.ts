import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../../common/supabase'
import { ListingScraperService } from '../services/listing-scraper.service'
import { GeoScoreCalculatorService } from '../services/geo-score-calculator.service'
import { GeoRecommendationsService } from '../services/geo-recommendations.service'
import { GeoTelemetryService } from '../services/geo-telemetry.service'

const CONCURRENCY = 3
const BACKOFFS_MS = [30_000, 120_000, 600_000] // 30s, 2min, 10min
const STALE_PROCESSING_MS = 5 * 60_000

interface JobRow {
  id: string
  org_id: string
  url: string
  platform: string | null
  requested_by: string | null
  retry_count: number
  max_retries: number
}

/**
 * Processa os jobs de GEO Score. Sem Redis → "fila" é estado no DB:
 * @Cron(30s) + kick() async no POST. Claim atômico via compare-and-swap
 * (update ... where status in (pending,retry) returning) evita processamento
 * duplo entre cron e kick. Retries com backoff (30s/2min/10min) → depois failed.
 * Resiliente: erro num job nunca derruba a fila (try/catch por job).
 */
@Injectable()
export class ScoreProcessorService {
  private readonly logger = new Logger(ScoreProcessorService.name)
  private ticking = false

  constructor(
    private readonly scraper:  ListingScraperService,
    private readonly calc:     GeoScoreCalculatorService,
    private readonly recs:     GeoRecommendationsService,
    private readonly telemetry: GeoTelemetryService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'geo-score-processor' })
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // 1. Reclama jobs travados em 'processing' (instância caiu no meio).
      await supabaseAdmin
        .from('ai_audit_jobs')
        .update({ status: 'retry', next_retry_at: new Date().toISOString() })
        .eq('status', 'processing')
        .lt('started_at', new Date(Date.now() - STALE_PROCESSING_MS).toISOString())
        .is('deleted_at', null)

      // 2. Pega elegíveis (pending/retry com janela de retry vencida).
      const nowIso = new Date().toISOString()
      const { data } = await supabaseAdmin
        .from('ai_audit_jobs')
        .select('id')
        .is('deleted_at', null)
        .in('status', ['pending', 'retry'])
        .or(`next_retry_at.is.null,next_retry_at.lte.${nowIso}`)
        .order('created_at', { ascending: true })
        .limit(CONCURRENCY)

      const ids = (data ?? []).map((r: { id: string }) => r.id)
      if (ids.length === 0) return
      await Promise.all(ids.map(id => this.claimAndProcess(id)))
    } catch (e) {
      this.logger.warn(`[geo-worker] tick falhou: ${(e as Error).message}`)
    } finally {
      this.ticking = false
    }
  }

  /** Disparado pelo POST pra começar na hora (não espera o tick). Fire-and-forget. */
  kick(jobId: string): void {
    void this.claimAndProcess(jobId).catch(e =>
      this.logger.warn(`[geo-worker] kick ${jobId} falhou: ${(e as Error).message}`),
    )
  }

  /** Compare-and-swap: só processa se conseguir marcar processing (status era pending/retry). */
  private async claimAndProcess(jobId: string): Promise<void> {
    const { data: claimed } = await supabaseAdmin
      .from('ai_audit_jobs')
      .update({ status: 'processing', started_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ['pending', 'retry'])
      .is('deleted_at', null)
      .select('id, org_id, url, platform, requested_by, retry_count, max_retries')
      .maybeSingle()

    if (!claimed) return // outro tick/kick já pegou
    await this.processJob(claimed as JobRow)
  }

  private async processJob(job: JobRow): Promise<void> {
    const attempt = job.retry_count + 1
    const t0 = Date.now()
    await this.telemetry.emit({
      orgId: job.org_id, userId: job.requested_by ?? '', jobId: job.id,
      eventName: 'geo_score.processing_started', properties: { jobId: job.id, attempt_number: attempt },
    })

    try {
      const scraped = await this.scraper.scrape(job.url, job.org_id)
      const score   = await this.calc.calculate(job.org_id, scraped)
      const rec     = await this.recs.generate(job.org_id, scraped, score.dimensions)
      const costUsd = +(score.costUsd + rec.costUsd).toFixed(6)

      // Resultado idempotente: limpa anterior (em caso de reprocesso) e insere.
      await supabaseAdmin.from('ai_audit_results').delete().eq('job_id', job.id)
      await supabaseAdmin.from('ai_audit_results').insert({
        job_id:               job.id,
        org_id:               job.org_id,
        geo_score:            score.geoScore,
        breakdown_json:       score.dimensions,
        recommendations_json: rec.recommendations,
        raw_scraped_data:     scraped,
      })
      await supabaseAdmin.from('ai_audit_jobs').update({
        status: 'completed', completed_at: new Date().toISOString(), cost_usd: costUsd, last_error: null,
      }).eq('id', job.id)

      const durationMs = Date.now() - t0
      await this.telemetry.emit({
        orgId: job.org_id, userId: job.requested_by ?? '', jobId: job.id, durationMs,
        eventName: 'geo_score.processing_completed',
        properties: { jobId: job.id, duration_ms: durationMs, score: score.geoScore, cost_usd: costUsd },
      })
      this.logger.log(`[geo-worker] job ${job.id} OK score=${score.geoScore} custo=$${costUsd} ${durationMs}ms`)
    } catch (e) {
      await this.handleFailure(job, attempt, (e as Error).message)
    }
  }

  private async handleFailure(job: JobRow, attempt: number, errMsg: string): Promise<void> {
    const willRetry = attempt <= job.max_retries
    if (willRetry) {
      const backoff = BACKOFFS_MS[Math.min(attempt - 1, BACKOFFS_MS.length - 1)]
      const nextRetryAt = new Date(Date.now() + backoff).toISOString()
      await supabaseAdmin.from('ai_audit_jobs').update({
        status: 'retry', retry_count: attempt, next_retry_at: nextRetryAt, last_error: errMsg.slice(0, 1000),
      }).eq('id', job.id)
      await this.telemetry.emit({
        orgId: job.org_id, userId: job.requested_by ?? '', jobId: job.id,
        eventName: 'geo_score.processing_failed',
        properties: { jobId: job.id, attempt_number: attempt, error: errMsg.slice(0, 300), will_retry: true },
      })
      await this.telemetry.emit({
        orgId: job.org_id, userId: job.requested_by ?? '', jobId: job.id,
        eventName: 'geo_score.retry_scheduled',
        properties: { jobId: job.id, next_retry_at: nextRetryAt, attempt_number: attempt },
      })
      this.logger.warn(`[geo-worker] job ${job.id} falhou (tentativa ${attempt}), retry em ${backoff}ms: ${errMsg}`)
    } else {
      await supabaseAdmin.from('ai_audit_jobs').update({
        status: 'failed', retry_count: attempt, last_error: errMsg.slice(0, 1000), error: errMsg.slice(0, 1000),
      }).eq('id', job.id)
      await this.telemetry.emit({
        orgId: job.org_id, userId: job.requested_by ?? '', jobId: job.id,
        eventName: 'geo_score.processing_failed',
        properties: { jobId: job.id, attempt_number: attempt, error: errMsg.slice(0, 300), will_retry: false },
      })
      this.logger.error(`[geo-worker] job ${job.id} FALHOU definitivamente após ${attempt} tentativas: ${errMsg}`)
    }
  }
}
