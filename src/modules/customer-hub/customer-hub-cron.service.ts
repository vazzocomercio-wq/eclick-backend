import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { CustomerHubService } from './customer-hub.service'
import { SegmentEvaluatorService } from './segment-evaluator.service'

/** Cron @03:00 BRT (06:00 UTC) — recalcula RFM/ABC/churn/segmento pra
 * todas as orgs ativas + reavalia segmentos com auto_refresh=true.
 * Executa em série (1 org por vez) pra não estourar Postgres com
 * múltiplas chamadas de compute_customer_metrics() concorrentes. */
@Injectable()
export class CustomerHubCronService {
  private readonly logger = new Logger(CustomerHubCronService.name)

  constructor(
    private readonly hub:       CustomerHubService,
    private readonly evaluator: SegmentEvaluatorService,
  ) {}

  @Cron('17 3 * * *', { name: 'customerHubMetricsTick' })
  async tick(): Promise<void> {
    const t0 = Date.now()
    let orgs = 0, customers = 0, segments = 0

    const orgIds = await this.hub.listActiveOrgs()
    for (const orgId of orgIds) {
      try {
        const r = await this.hub.computeMetrics(orgId)
        orgs++
        customers += r.updated
      } catch (e: unknown) {
        this.logger.warn(`[customer-hub.cron] org=${orgId} compute falhou: ${(e as Error)?.message}`)
        continue
      }

      // Reavalia segmentos auto_refresh=true desta org
      try {
        const { data: segs } = await supabaseAdmin
          .from('customer_segments')
          .select('id, rules')
          .eq('organization_id', orgId)
          .eq('auto_refresh', true)
        for (const seg of segs ?? []) {
          try {
            const ids = await this.evaluator.matchCustomerIds(orgId, (seg.rules ?? []) as []); // eslint-disable-line
            await supabaseAdmin.from('customer_segment_members').delete().eq('segment_id', seg.id)
            if (ids.length > 0) {
              const rows = ids.map(cid => ({ segment_id: seg.id, customer_id: cid }))
              for (let i = 0; i < rows.length; i += 500) {
                await supabaseAdmin.from('customer_segment_members').insert(rows.slice(i, i + 500))
              }
            }
            await supabaseAdmin
              .from('customer_segments')
              .update({ customer_count: ids.length, last_computed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('id', seg.id)
            segments++
          } catch (e: unknown) {
            this.logger.warn(`[customer-hub.cron] segment=${seg.id} eval falhou: ${(e as Error)?.message}`)
          }
        }
      } catch (e: unknown) {
        this.logger.warn(`[customer-hub.cron] org=${orgId} fetch segments falhou: ${(e as Error)?.message}`)
      }
    }

    const dur = Math.round((Date.now() - t0) / 1000)
    this.logger.log(`[customer-hub.cron] ${orgs} orgs, ${customers} clientes, ${segments} segmentos atualizados — ${dur}s`)
  }
}
