import { Controller, Get, Post, Body, UseGuards, HttpCode } from '@nestjs/common'
import { AdminSecretGuard } from './admin-secret.guard'
import { BackfillService } from '../sales-aggregator/services/backfill.service'
import { OrdersIngestionService } from '../sales-aggregator/services/orders-ingestion.service'
import { MlBillingFetcherService } from '../mercadolivre/ml-billing-fetcher.service'
import { supabaseAdmin } from '../../common/supabase'

interface SyncBody {
  days?:    number
  org_id?:  string
}

/** Endpoints administrativos chamáveis sem session Supabase — protegidos
 * por header `x-admin-secret` (env ADMIN_SECRET). Pensados pra cron OS /
 * GitHub Actions / qualquer trigger externo confiável. */
@Controller('admin')
@UseGuards(AdminSecretGuard)
export class AdminController {
  constructor(
    private readonly backfill:        BackfillService,
    private readonly ingestion:       OrdersIngestionService,
    private readonly billingFetcher:  MlBillingFetcherService,
  ) {}

  /** GET /admin/sync-stats — same as /sales-aggregator/sync-stats but
   * sem auth Supabase (usa secret). Retorna last_sync e billing pending. */
  @Get('sync-stats')
  async syncStats() {
    const last = this.ingestion.getLastStats()
    const pending = await this.billingFetcher.countPending().catch(() => -1)
    const orphans = await this.billingFetcher.countOrphans().catch(() => -1)
    return {
      last_sync:      last,
      billing_pending: pending,
      billing_orphans: orphans,
      cron_interval_minutes: 60,
    }
  }

  /** POST /admin/sync-now { days?: 1-7, org_id?: string }
   * Resolve org_id (ou pega a primeira org com ml_connections) e dispara
   * startRun('manual', days). Retorna o runId. Body é opcional. */
  @Post('sync-now')
  @HttpCode(202)
  async syncNow(@Body() body: SyncBody = {}) {
    const days  = Math.min(Math.max(Number(body?.days ?? 1), 1), 7)
    const orgId = body?.org_id ?? null

    if (orgId) {
      const { runId } = await this.backfill.syncNow(orgId, days)
      return { ok: true, runId, days, org_id: orgId }
    }

    // Sem org_id → dispara pra TODAS as orgs com ml_connections
    const { data: connections } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
    const orgIds = [...new Set((connections ?? []).map((c: { organization_id: string }) => c.organization_id))]

    const runs: Array<{ org_id: string; runId?: string; error?: string }> = []
    for (const id of orgIds) {
      try {
        const { runId } = await this.backfill.syncNow(id, days)
        runs.push({ org_id: id, runId })
      } catch (e: unknown) {
        runs.push({ org_id: id, error: (e as Error)?.message ?? 'erro' })
      }
    }
    return { ok: true, days, orgs: runs.length, runs }
  }
}
