import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { StockService } from './stock.service'
import { supabaseAdmin } from '../../common/supabase'

@Injectable()
export class StockCron {
  private readonly logger = new Logger(StockCron.name)

  constructor(private readonly stockService: StockService) {}

  // Every hour: release expired reservations
  @Cron('0 * * * *')
  async releaseExpired() {
    try {
      const count = await this.stockService.releaseExpiredReservations()
      if (count > 0) this.logger.log(`Released ${count} expired reservations`)
    } catch (err) {
      this.logger.error('releaseExpired failed', err)
    }
  }

  // Daily at 00:00 — recalculate auto-distribution percentages
  // for every product with at least one active distribution row in 'auto' mode
  @Cron('0 0 * * *')
  async recalcAutoDaily() {
    try {
      const { data: rows } = await supabaseAdmin
        .from('channel_stock_distribution')
        .select('product_id')
        .eq('distribution_mode', 'auto')
        .eq('is_active', true)

      const uniqueIds = [...new Set((rows ?? []).map(r => r.product_id as string))]
      if (uniqueIds.length === 0) return

      let success = 0, errors = 0
      for (const productId of uniqueIds) {
        try {
          await this.stockService.applyAutoDistribution(productId, 'cron_daily')
          success++
        } catch (e: any) {
          errors++
          this.logger.error(`[cron.recalc] erro produto ${productId}: ${e?.message}`)
        }
      }

      this.logger.log(`[cron.recalc] ${success}/${uniqueIds.length} ok, ${errors} erro`)
    } catch (err) {
      this.logger.error('[cron.recalc] falhou', err)
    }
  }

  // Diário 04:00 — reconciliação: re-empurra o estoque correto pra todo
  // anúncio ML vinculado, pegando divergência (edição manual no ML ou push
  // que falhou). Idempotente; loga em stock_sync_logs.
  @Cron('0 4 * * *', { name: 'stock-reconcile-ml' })
  async reconcileMlStock() {
    try {
      const result = await this.stockService.syncAllProductsWithMlListing()
      this.logger.log(`[cron.reconcile] ${result.success}/${result.total} ok, ${result.errors} erro`)
    } catch (err) {
      this.logger.error('[cron.reconcile] falhou', err)
    }
  }

  // A cada 15 min: rede de segurança da baixa de estoque na venda.
  // O caminho primário é o webhook (ingestSingleOrder → applySaleMovement);
  // este cron pega pedido ML pago das últimas 48h cujo webhook se perdeu.
  // Idempotente — quem já baixou pelo webhook vira noop.
  @Cron('*/15 * * * *', { name: 'stock-reconcile-orders' })
  async reconcileStockFromOrders() {
    try {
      const since = new Date(Date.now() - 48 * 3600_000).toISOString()
      const { data: rows } = await supabaseAdmin
        .from('orders')
        .select('external_order_id, product_id, quantity, status')
        .eq('platform', 'mercadolivre')
        .in('status', ['paid', 'shipped', 'delivered'])
        .not('product_id', 'is', null)
        .gte('sold_at', since)
        .limit(500)

      if (!rows?.length) return

      // Agrega por pedido+produto (um pedido pode ter 2 linhas do mesmo produto)
      const agg = new Map<string, { productId: string; externalOrderId: string; status: string; quantity: number }>()
      for (const r of rows) {
        const key = `${r.external_order_id}:${r.product_id}`
        const cur = agg.get(key)
        if (cur) {
          cur.quantity += Number(r.quantity) || 0
        } else {
          agg.set(key, {
            productId:       r.product_id as string,
            externalOrderId: String(r.external_order_id),
            status:          String(r.status),
            quantity:        Number(r.quantity) || 0,
          })
        }
      }

      let applied = 0
      for (const m of agg.values()) {
        const result = await this.stockService
          .applySaleMovement({ ...m, channel: 'mercadolivre' })
          .catch(e => {
            this.logger.warn(`[cron.reconcile-orders] pedido ${m.externalOrderId}: ${(e as Error)?.message}`)
            return 'noop' as const
          })
        if (result === 'decremented') applied++
      }
      if (applied > 0) {
        this.logger.log(`[cron.reconcile-orders] ${applied} venda(s) baixadas (webhook perdido)`)
      }
    } catch (err) {
      this.logger.error('[cron.reconcile-orders] falhou', err)
    }
  }
}
