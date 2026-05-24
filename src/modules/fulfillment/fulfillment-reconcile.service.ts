import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { FulfillmentService } from './fulfillment.service'

/**
 * F12 Sprint 3 — reconciliação periódica. Rede de segurança: se um webhook de
 * pagamento se perder, o pedido pago não vira fila. A cada 30min varremos as
 * orgs com auto-ingestão ligada e ingerimos os pagos recentes que ficaram de
 * fora. Idempotente (reusa autoIngest* → seed com UNIQUE).
 */
@Injectable()
export class FulfillmentReconcileService {
  private readonly logger = new Logger(FulfillmentReconcileService.name)

  constructor(private readonly fulfillment: FulfillmentService) {}

  @Cron('0 */30 * * * *', { name: 'fulfillment-reconcile' })
  async reconcileAll(): Promise<void> {
    try {
      const { data: orgs } = await supabaseAdmin
        .from('fulfillment_settings').select('organization_id').eq('auto_ingest_enabled', true)
      const list = (orgs ?? []) as Array<{ organization_id: string }>
      if (list.length === 0) return
      let total = 0
      for (const o of list) {
        try {
          const r = await this.fulfillment.reconcileOrg(o.organization_id)
          total += (r.storefront ?? 0) + (r.marketplace ?? 0)
        } catch (e) {
          this.logger.warn(`[reconcile] org=${o.organization_id.slice(0, 8)}: ${(e as Error).message}`)
        }
      }
      if (total > 0) this.logger.log(`[reconcile] tick: ${total} pedido(s) reconciliado(s) em ${list.length} org(s)`)
    } catch (e) {
      this.logger.warn(`[reconcile] tick falhou: ${(e as Error).message}`)
    }
  }
}
