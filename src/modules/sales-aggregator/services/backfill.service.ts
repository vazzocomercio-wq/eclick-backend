import { Injectable, HttpException, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { Cron, SchedulerRegistry } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { OrdersIngestionService } from './orders-ingestion.service'
import { SnapshotsAggregationService } from './snapshots-aggregation.service'

export interface AggregatorRun {
  id: string
  organization_id: string
  run_type: string
  status: string
  start_date: string
  end_date: string
  total_dates: number
  processed_dates: number
  current_date_processing: string | null
  orders_fetched: number
  orders_inserted: number
  orders_updated: number
  snapshots_inserted: number
  api_calls_made: number
  started_at: string
  completed_at: string | null
  duration_seconds: number | null
  error_message: string | null
  error_details: unknown | null
  triggered_by: string | null
  created_at: string
}

@Injectable()
export class BackfillService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BackfillService.name)

  constructor(
    private readonly ordersIngestion: OrdersIngestionService,
    private readonly snapshotsAggregation: SnapshotsAggregationService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {
    this.logger.log('[BackfillService] inicializado, crons serão registrados pelo @Cron')
  }

  /** Healthcheck no startup — confirma que os @Cron decorators do
   * BackfillService chegaram a registrar no SchedulerRegistry. Se algum
   * estiver ausente, loga ERROR (visível no Railway). */
  onApplicationBootstrap() {
    try {
      const jobs = this.schedulerRegistry.getCronJobs()
      const all  = Array.from(jobs.keys())
      this.logger.log(`[health.cron] crons globais registrados: ${all.length} → ${all.join(' | ')}`)

      const expected = ['dailyAggregation', 'hourlySync']
      for (const name of expected) {
        const job = jobs.get(name)
        if (job) {
          const next = job.nextDate()
          this.logger.log(`[health.cron] ✓ ${name} próxima execução: ${next.toString()}`)
        } else {
          this.logger.error(`[health.cron] ✗ ${name} NÃO encontrado — @Cron não registrou. Verifique ScheduleModule.forRoot() em app.module.ts`)
        }
      }
    } catch (e: unknown) {
      this.logger.error(`[health.cron] erro ao validar crons: ${(e as Error)?.message}`)
    }
  }

  async startBackfill(orgId: string | null, days: number, userId: string | null): Promise<{ runId: string }> {
    return this.startRun(await this.resolveOrgId(orgId), 'backfill', days, userId)
  }

  async runManual(orgId: string | null, days: number, userId: string | null): Promise<{ runId: string }> {
    return this.startRun(await this.resolveOrgId(orgId), 'manual', days, userId)
  }

  async runDaily(orgId: string | null, userId: string | null): Promise<{ runId: string }> {
    return this.startRun(await this.resolveOrgId(orgId), 'daily', 3, userId)
  }

  async getStatus(orgId: string | null): Promise<{ activeRun: AggregatorRun | null; recentRuns: AggregatorRun[] }> {
    orgId = await this.resolveOrgId(orgId)
    const { data: all } = await supabaseAdmin
      .from('aggregator_runs')
      .select('*')
      .eq('organization_id', orgId)
      .order('started_at', { ascending: false })
      .limit(21)

    const rows = (all ?? []) as AggregatorRun[]
    const activeRun = rows.find(r => r.status === 'running') ?? null
    const recentRuns = rows.filter(r => r.status !== 'running').slice(0, 20)
    return { activeRun, recentRuns }
  }

  async cancelRun(orgId: string | null, runId: string): Promise<void> {
    orgId = await this.resolveOrgId(orgId)
    const { error } = await supabaseAdmin
      .from('aggregator_runs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', runId)
      .eq('organization_id', orgId)
    if (error) throw new HttpException(error.message, 500)
  }

  private async resolveOrgId(orgId: string | null): Promise<string> {
    if (orgId) return orgId

    // ml_connections with non-null organization_id
    const { data: conn } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
      .not('organization_id', 'is', null)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (conn?.organization_id) return conn.organization_id as string

    // Last resort: first org in the system (solo-owner setup where org_id wasn't set on connect)
    const { data: org } = await supabaseAdmin
      .from('organizations')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (org?.id) {
      // Patch null organization_id rows so future calls resolve correctly
      await supabaseAdmin
        .from('ml_connections')
        .update({ organization_id: org.id })
        .is('organization_id', null)
      return org.id as string
    }

    throw new HttpException('Nenhuma organização encontrada. Configure uma organização primeiro.', 400)
  }

  @Cron('0 5 * * *', { name: 'dailyAggregation' }) // 02:00 BRT — full 3-day window
  async dailyAggregation(): Promise<void> {
    console.log(`[ml-sync.cron] iniciando ciclo diário (3 dias)…`)
    const { data: connections } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
    const orgIds = [...new Set((connections ?? []).map((c: { organization_id: string }) => c.organization_id))]

    for (const orgId of orgIds) {
      try {
        await this.runDaily(orgId, null)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ml-sync.cron] daily falhou para org ${orgId}:`, msg)
      }
    }
    if (orgIds.length > 0) console.log(`[ml-sync.cron] daily completo: ${orgIds.length} orgs`)
  }

  /** Hourly incremental sync — pega orders das últimas 24h por org.
   * Garante que pedidos novos do dia entram no banco com CPF (auto-billing
   * roda dentro de ingestDateRange) sem precisar esperar o cron das 02h. */
  @Cron('17 * * * *', { name: 'hourlySync' })
  async hourlySync(): Promise<void> {
    console.log(`[ml-sync.cron] iniciando ciclo horário (1 dia)…`)
    const { data: connections } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
    const orgIds = [...new Set((connections ?? []).map((c: { organization_id: string }) => c.organization_id))]

    let okOrgs = 0
    for (const orgId of orgIds) {
      try {
        await this.startRun(orgId, 'manual', 1, null)
        okOrgs++
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[ml-sync.cron] hourly falhou para org ${orgId}:`, msg)
      }
    }
    if (orgIds.length > 0) {
      console.log(`[ml-sync.cron] hourly completo: ${okOrgs}/${orgIds.length} orgs — próxima execução em 60min`)
    }
  }

  /** Manual instant trigger — POST /sales-aggregator/sync-now */
  async syncNow(orgId: string | null, days = 1): Promise<{ runId: string }> {
    return this.startRun(await this.resolveOrgId(orgId), 'manual', Math.min(Math.max(days, 1), 7), null)
  }

  private async startRun(
    orgId: string,
    runType: 'backfill' | 'daily' | 'manual',
    days: number,
    userId: string | null,
  ): Promise<{ runId: string }> {
    // Check for active run
    const { data: active } = await supabaseAdmin
      .from('aggregator_runs')
      .select('id')
      .eq('organization_id', orgId)
      .eq('status', 'running')
      .limit(1)
      .maybeSingle()

    if (active) {
      throw new HttpException('Já existe uma execução em andamento para esta organização', 409)
    }

    const endDate = new Date()
    endDate.setUTCHours(12, 0, 0, 0)
    const startDate = new Date(endDate)
    startDate.setUTCDate(startDate.getUTCDate() - (days - 1))

    const dateFrom = startDate.toISOString().slice(0, 10)
    const dateTo   = endDate.toISOString().slice(0, 10)
    const totalDates = days

    const { data: run, error: createErr } = await supabaseAdmin
      .from('aggregator_runs')
      .insert({
        organization_id:  orgId,
        run_type:         runType,
        status:           'running',
        start_date:       dateFrom,
        end_date:         dateTo,
        total_dates:      totalDates,
        processed_dates:  0,
        triggered_by:     userId,
        started_at:       new Date().toISOString(),
      })
      .select('id')
      .single()

    if (createErr || !run) {
      throw new HttpException(createErr?.message ?? 'Erro ao criar run', 500)
    }

    const runId = run.id as string

    // Fire and forget background processing
    const startedAt = Date.now()
    ;(async () => {
      const errorDetails: Array<{ date: string; error: string }> = []
      try {
        const ingestionStats = await this.ordersIngestion.ingestDateRange(orgId, dateFrom, dateTo, runId)
        if (ingestionStats.errors.length) errorDetails.push(...ingestionStats.errors)

        await this.snapshotsAggregation.aggregateDateRange(orgId, dateFrom, dateTo, runId)

        const duration = Math.round((Date.now() - startedAt) / 1000)
        await supabaseAdmin
          .from('aggregator_runs')
          .update({
            status:          'completed',
            completed_at:    new Date().toISOString(),
            duration_seconds: duration,
            error_details:   errorDetails.length ? errorDetails : null,
          })
          .eq('id', runId)

      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[aggregator] run ${runId} failed:`, msg)
        await supabaseAdmin
          .from('aggregator_runs')
          .update({
            status:          'failed',
            completed_at:    new Date().toISOString(),
            duration_seconds: Math.round((Date.now() - startedAt) / 1000),
            error_message:   msg,
            error_details:   errorDetails,
          })
          .eq('id', runId)
      }
    })()

    return { runId }
  }
}
