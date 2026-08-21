import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { MlReputationDataService } from './ml-reputation-data.service'
import { MlReputationService } from './ml-reputation.service'

/**
 * Crons do módulo de reputação.
 *
 *   • dirty sweep (a cada 5 min): contas marcadas pelo webhook cujo timer de
 *     debounce se perdeu (restart do processo). Normalmente não acha nada.
 *   • hourly (:53): recalcula TODAS as contas. Roda depois do sync oficial
 *     (:47, executive-reputation.cron) pra comparar local × oficial com o
 *     dado mais fresco. É também o que garante o snapshot diário e a janela
 *     móvel andando mesmo sem nenhum evento novo (uma venda antiga SAIR da
 *     janela não gera webhook).
 *
 * Não é polling no ML: só lê o banco local. O único acesso externo é o
 * backfill de cancel_detail, 1× por conta.
 */
@Injectable()
export class MlReputationCron {
  private readonly logger = new Logger(MlReputationCron.name)

  constructor(
    private readonly reputation: MlReputationService,
    private readonly data:       MlReputationDataService,
  ) {}

  @Cron('*/5 * * * *', { name: 'mlReputationDirtySweep' })
  async dirtySweep(): Promise<void> {
    if (process.env.DISABLE_ML_REPUTATION_ENGINE === 'true') return
    const staleBefore = new Date(Date.now() - 60_000).toISOString()
    const { data } = await supabaseAdmin
      .from('ml_reputation_current')
      .select('organization_id, seller_id')
      .not('dirty_since', 'is', null)
      .lte('dirty_since', staleBefore)
      .limit(50)
    const rows = (data ?? []) as Array<{ organization_id: string; seller_id: number }>
    if (rows.length === 0) return
    let ok = 0
    for (const r of rows) {
      try {
        await this.reputation.recalculate(r.organization_id, Number(r.seller_id), { reason: 'dirty_sweep' })
        ok++
      } catch (err) {
        this.logger.warn(`[dirty-sweep] seller=${r.seller_id}: ${(err as Error).message}`)
      }
    }
    this.logger.log(`[dirty-sweep] ${ok}/${rows.length} contas recalculadas`)
  }

  @Cron('53 * * * *', { name: 'mlReputationHourly' })
  async hourly(): Promise<void> {
    if (process.env.DISABLE_ML_REPUTATION_ENGINE === 'true') return
    const t0 = Date.now()
    const sellers = await this.data.listAllConnections()
    if (sellers.length === 0) return
    let ok = 0
    let fail = 0
    for (const { orgId, sellerId } of sellers) {
      try {
        await this.reputation.recalculate(orgId, sellerId, { reason: 'hourly' })
        ok++
      } catch (err) {
        fail++
        this.logger.warn(`[hourly] org=${orgId.slice(0, 8)} seller=${sellerId}: ${(err as Error).message}`)
      }
    }
    this.logger.log(`[hourly] ${ok}/${sellers.length} ok, ${fail} falhas em ${Math.round((Date.now() - t0) / 1000)}s`)
  }
}
