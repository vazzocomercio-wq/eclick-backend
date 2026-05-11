import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { VisitsScannerService } from './visits-scanner.service'
import type { ScanOptions } from './dto/scan-result.dto'

/**
 * F11 Fase 2 — Cron diário de visits scanner.
 *
 * 03:30 BRT — itera todas as orgs que têm ml_connections. organizations
 * não tem coluna `is_active` no schema atual, então a "ativação" é
 * inferida pela presença em ml_connections (mesmo padrão dos outros
 * crons F11).
 *
 * ENV-gated: ML_VISITS_SCAN_ENABLED=true precisa estar setado em Railway
 * pra cron rodar. Default off pra rollout controlado.
 */
function parsePeriodList(csv: string | undefined, fallback: number[]): number[] {
  if (!csv) return fallback
  const parsed = csv.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
  return parsed.length > 0 ? parsed : fallback
}

@Injectable()
export class VisitsScannerCron {
  private readonly logger = new Logger(VisitsScannerCron.name)

  constructor(private readonly scanner: VisitsScannerService) {}

  /** 03:30 BRT — scan diário. */
  @Cron('30 6 * * *', { name: 'mlVisitsScannerDaily' })
  async run(): Promise<void> {
    if (process.env.ML_VISITS_SCAN_ENABLED !== 'true') {
      this.logger.debug('[visits-scanner.cron] disabled (ML_VISITS_SCAN_ENABLED != true) — skipping')
      return
    }

    const t0 = Date.now()
    const opts = this.readOptsFromEnv()

    const orgs = await this.fetchActiveOrgs()
    if (orgs.length === 0) {
      this.logger.log('[visits-scanner.cron] nenhuma org conectada ao ML — pulando')
      return
    }

    let ok = 0
    let fail = 0
    for (const orgId of orgs) {
      try {
        const results = await this.scanner.scanOrganization(orgId, opts)
        this.logger.log({
          event: 'visits_scan_complete',
          orgId,
          totalSellers: results.length,
          totals: results.map(r => ({
            seller: r.sellerId,
            ok: r.success, skipped: r.skipped, failed: r.failed,
            durationMs: r.durationMs,
          })),
        })
        ok++
      } catch (err) {
        this.logger.error({
          event: 'visits_scan_failed',
          orgId,
          err: (err as Error).message,
        })
        fail++
        // Não derruba scan global — próxima org continua.
      }
    }

    this.logger.log(
      `[visits-scanner.cron] done ${ok}/${orgs.length} orgs ok, ${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`,
    )
  }

  /** Lê opções de cron a partir das ENV vars Railway. */
  private readOptsFromEnv(): Partial<ScanOptions> {
    const rateLimitMs       = Number(process.env.ML_VISITS_SCAN_RATE_LIMIT_MS ?? 1000)
    const maxRetries        = Number(process.env.ML_VISITS_SCAN_MAX_RETRIES   ?? 3)
    const maxItemsPerSeller = Number(process.env.ML_VISITS_SCAN_MAX_ITEMS_PER_SELLER ?? 2000)
    const periodDays        = parsePeriodList(process.env.ML_VISITS_SCAN_PERIODS, [7])
    return {
      rateLimitMs:        Number.isFinite(rateLimitMs) ? rateLimitMs : 1000,
      maxRetries:         Number.isFinite(maxRetries)  ? maxRetries  : 3,
      maxItemsPerSeller:  Number.isFinite(maxItemsPerSeller) ? maxItemsPerSeller : 2000,
      periodDays,
    }
  }

  /**
   * organizations.is_active não existe — usar presença em ml_connections
   * como sinal de "org com ML ativo" (mesmo padrão dos outros crons F11).
   */
  private async fetchActiveOrgs(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('organization_id')
      .not('organization_id', 'is', null)
    const rows = (data ?? []) as Array<{ organization_id: string }>
    return Array.from(new Set(rows.map(r => r.organization_id).filter(Boolean)))
  }
}
