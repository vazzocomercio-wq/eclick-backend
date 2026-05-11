import { Injectable, Logger } from '@nestjs/common'
import axios, { AxiosError } from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'
import type {
  ScanOptions, ScanResult, ScanItemResult,
} from './dto/scan-result.dto'
import type { MlItemVisitsTimeWindowResponse } from './dto/visits-api-response.dto'

/**
 * F11 Fase 2 — Scanner de visitas por item ML.
 *
 * Popula ml_item_visits_period via /items/{id}/visits/time_window per item.
 * Fonte de items ativos: ml_quality_snapshots (último snapshot ≤ 7d).
 *
 * Multi-conta: SEMPRE passa sellerId em MercadolivreService.getTokenForOrg
 * (feedback_ml_multiconta_token). Em 401, re-chama getTokenForOrg que já
 * faz refresh interno via refreshIfNeeded.
 *
 * Matriz de retry:
 *   200       → upsert + sucesso
 *   401       → re-getTokenForOrg + retry (não conta attempt)
 *   404/410   → recordError 'item_not_found', skip permanente neste scan
 *   429       → cooldown 60s + retry (não conta attempt)
 *   5xx/net   → backoff 5s → 25s → 30s cap, conta attempt
 *
 * Skip-on-error INTER-scan: próximo run sempre tenta de novo
 * (item pode ter sido reativado). Quarentena dura é TODO V2.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const DEFAULT_OPTS: ScanOptions = {
  periodDays:        [7],
  rateLimitMs:       1000,
  maxRetries:        3,
  maxItemsPerSeller: 2000,
}

interface ScanItemContext {
  organizationId: string
  sellerId:       number
  mlItemId:       string
  periodDays:     number
  periodStart:    string                          // YYYY-MM-DD
  periodEnd:      string                          // YYYY-MM-DD
}

@Injectable()
export class VisitsScannerService {
  private readonly logger = new Logger(VisitsScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  /** Itera todos os sellers de uma org. */
  async scanOrganization(
    orgId: string,
    opts: Partial<ScanOptions> = {},
  ): Promise<ScanResult[]> {
    const merged: ScanOptions = { ...DEFAULT_OPTS, ...opts }
    const sellers = await this.listSellers(orgId)
    if (sellers.length === 0) {
      this.logger.warn(`[visits-scanner] org=${orgId.slice(0, 8)} sem ml_connections — pulando`)
      return []
    }

    const results: ScanResult[] = []
    for (const sellerId of sellers) {
      try {
        const r = await this.scanSeller(orgId, sellerId, merged)
        results.push(r)
      } catch (err) {
        this.logger.error(
          `[visits-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} falhou: ${(err as Error).message}`,
        )
      }
    }
    return results
  }

  /** Scan de 1 (org, seller) × N períodos. */
  async scanSeller(
    orgId:    string,
    sellerId: number,
    opts:     ScanOptions,
  ): Promise<ScanResult> {
    const start = Date.now()

    // Multi-conta: sellerId explícito é OBRIGATÓRIO (feedback_ml_multiconta_token)
    let token: string
    try {
      const res = await this.ml.getTokenForOrg(orgId, sellerId)
      token = res.token
    } catch (err) {
      throw new Error(`no_token: org=${orgId} seller=${sellerId} (${(err as Error).message})`)
    }

    // Items ativos: ml_quality_snapshots último snapshot ≤ 7 dias
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: items, error: itemsErr } = await supabaseAdmin
      .from('ml_quality_snapshots')
      .select('ml_item_id')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .gte('fetched_at',     sevenDaysAgo)
    if (itemsErr) throw new Error(`list items: ${itemsErr.message}`)

    const rows = (items ?? []) as Array<{ ml_item_id: string }>
    const uniqueItems = Array.from(new Set(rows.map(r => r.ml_item_id))).filter(Boolean)
    const capped = opts.maxItemsPerSeller
      ? uniqueItems.slice(0, opts.maxItemsPerSeller)
      : uniqueItems

    this.logger.log(
      `[visits-scanner] start org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `items=${capped.length} periods=${opts.periodDays.join(',')}`,
    )

    // Resultado agregado (primeiro período como base; multi-period é raro no MVP)
    const aggregate: ScanResult = {
      organizationId: orgId,
      sellerId,
      periodDays:     opts.periodDays[0],
      itemsTotal:     capped.length,
      success:        0,
      skipped:        0,
      failed:         0,
      durationMs:     0,
      errorsByStatus: {},
    }

    for (const periodDays of opts.periodDays) {
      // Janela coerente com o que o endpoint retorna (data UTC, hoje 00:00 como fim).
      const today = new Date()
      const periodEndDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
      const periodStartDate = new Date(periodEndDate.getTime() - periodDays * 24 * 60 * 60 * 1000)
      const periodEnd   = periodEndDate.toISOString().slice(0, 10)
      const periodStart = periodStartDate.toISOString().slice(0, 10)

      for (const itemId of capped) {
        const ctx: ScanItemContext = {
          organizationId: orgId, sellerId,
          mlItemId: itemId, periodDays, periodStart, periodEnd,
        }
        const r = await this.scanItem(ctx, token, opts)
        if (r.ok) {
          aggregate.success++
        } else if (r.httpStatus === 404 || r.httpStatus === 410) {
          aggregate.skipped++
          aggregate.errorsByStatus[r.httpStatus] = (aggregate.errorsByStatus[r.httpStatus] ?? 0) + 1
        } else {
          aggregate.failed++
          aggregate.errorsByStatus[r.httpStatus] = (aggregate.errorsByStatus[r.httpStatus] ?? 0) + 1
        }
        // Rate-limit entre chamadas
        await sleep(opts.rateLimitMs)
      }
    }

    aggregate.durationMs = Date.now() - start
    this.logger.log(
      `[visits-scanner] done org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `success=${aggregate.success} skipped=${aggregate.skipped} failed=${aggregate.failed} ` +
      `duration=${Math.round(aggregate.durationMs / 1000)}s`,
    )
    return aggregate
  }

  /** Scan de 1 item × 1 período. Retorna resultado + retry interno. */
  async scanItem(
    ctx:  ScanItemContext,
    initialToken: string,
    opts: ScanOptions,
  ): Promise<ScanItemResult> {
    let attempt       = 0
    let currentToken  = initialToken
    let lastStatus    = 0

    while (attempt < opts.maxRetries) {
      try {
        const url = `https://api.mercadolibre.com/items/${ctx.mlItemId}/visits/time_window?last=${ctx.periodDays}&unit=day`
        const res = await axios.get<MlItemVisitsTimeWindowResponse>(url, {
          headers: { Authorization: `Bearer ${currentToken}` },
          timeout: 10_000,
        })

        await this.upsertVisits(ctx, {
          httpStatus:     res.status,
          totalVisits:    res.data.total_visits ?? 0,
          dailyBreakdown: res.data.results ?? [],
          errorMessage:   null,
        })
        return { ok: true, httpStatus: res.status, visits: res.data.total_visits ?? 0 }
      } catch (err) {
        const axiosErr = err as AxiosError
        const status   = axiosErr.response?.status ?? 0
        lastStatus     = status

        // 404 / 410: item morto. Skip permanente neste scan.
        if (status === 404 || status === 410) {
          await this.upsertVisits(ctx, {
            httpStatus:     status,
            totalVisits:    0,
            dailyBreakdown: [],
            errorMessage:   'item_not_found',
          })
          return { ok: false, httpStatus: status, error: 'item_not_found' }
        }

        // 401: token expirado. Re-getTokenForOrg (já refresca internamente).
        // NÃO consume attempt.
        if (status === 401) {
          this.logger.warn(`[visits-scanner] 401 item=${ctx.mlItemId} — refreshing token`)
          try {
            const res = await this.ml.getTokenForOrg(ctx.organizationId, ctx.sellerId)
            currentToken = res.token
          } catch (refreshErr) {
            await this.upsertVisits(ctx, {
              httpStatus:     401,
              totalVisits:    0,
              dailyBreakdown: [],
              errorMessage:   `token_refresh_failed: ${(refreshErr as Error).message}`,
            })
            return { ok: false, httpStatus: 401, error: 'token_refresh_failed' }
          }
          continue
        }

        // 429: rate-limit ML. Cooldown 60s + retry (não conta attempt).
        if (status === 429) {
          this.logger.warn(`[visits-scanner] 429 item=${ctx.mlItemId} — cooldown 60s`)
          await sleep(60_000)
          continue
        }

        // 5xx / network / timeout: backoff exponencial 5s → 25s → 30s cap.
        attempt++
        if (attempt < opts.maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(5, attempt), 30_000)
          this.logger.warn(
            `[visits-scanner] ${status || 'net'} item=${ctx.mlItemId} attempt=${attempt} backoff=${backoffMs}ms`,
          )
          await sleep(backoffMs)
        } else {
          await this.upsertVisits(ctx, {
            httpStatus:     status,
            totalVisits:    0,
            dailyBreakdown: [],
            errorMessage:   axiosErr.message || `http_${status}`,
          })
          return { ok: false, httpStatus: status, error: axiosErr.message }
        }
      }
    }

    return { ok: false, httpStatus: lastStatus, error: 'max_retries_exhausted' }
  }

  /** Upsert na ml_item_visits_period — UNIQUE em (org, seller, item, period_days, period_end). */
  private async upsertVisits(
    ctx: ScanItemContext,
    fields: {
      httpStatus:     number
      totalVisits:    number
      dailyBreakdown: unknown[]
      errorMessage:   string | null
    },
  ): Promise<void> {
    const { error } = await supabaseAdmin
      .from('ml_item_visits_period')
      .upsert({
        organization_id: ctx.organizationId,
        seller_id:       ctx.sellerId,
        ml_item_id:      ctx.mlItemId,
        period_days:     ctx.periodDays,
        period_start:    ctx.periodStart,
        period_end:      ctx.periodEnd,
        total_visits:    fields.totalVisits,
        daily_breakdown: fields.dailyBreakdown,
        last_synced_at:  new Date().toISOString(),
        sync_source:     'ml_api_v1',
        http_status:     fields.httpStatus,
        error_message:   fields.errorMessage,
      }, {
        onConflict: 'organization_id,seller_id,ml_item_id,period_days,period_end',
      })
    if (error) {
      this.logger.error(
        `[visits-scanner] upsert fail item=${ctx.mlItemId}: ${error.message}`,
      )
    }
  }

  /** Sellers conectados via ml_connections. */
  private async listSellers(orgId: string): Promise<number[]> {
    const { data } = await supabaseAdmin
      .from('ml_connections')
      .select('seller_id')
      .eq('organization_id', orgId)
    return ((data ?? []) as Array<{ seller_id: number }>).map(r => r.seller_id).filter(Boolean)
  }
}
