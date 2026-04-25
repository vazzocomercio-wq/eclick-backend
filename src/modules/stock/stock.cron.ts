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

  // Every 5 minutes: sync ML order reservations
  @Cron('*/5 * * * *')
  async syncMlOrderReservations() {
    try {
      // Fetch recent ML orders that need reservation updates
      const { data: orders } = await supabaseAdmin
        .from('orders')
        .select('id, external_id, status, items')
        .eq('channel', 'mercadolivre')
        .in('status', ['paid', 'processing'])
        .is('reservation_synced', null)
        .limit(50)

      if (!orders?.length) return

      for (const order of orders) {
        try {
          for (const item of (order.items as any[]) ?? []) {
            if (!item.product_id || !item.quantity) continue
            await this.stockService.reserveStock({
              productId: item.product_id,
              quantity: Number(item.quantity),
              referenceType: 'ml_order',
              referenceId: String(order.external_id || order.id),
              channel: 'mercadolivre',
            })
          }
          await supabaseAdmin
            .from('orders')
            .update({ reservation_synced: new Date().toISOString() })
            .eq('id', order.id)
        } catch (err) {
          this.logger.error(`Failed to reserve stock for order ${order.id}`, err)
        }
      }
    } catch (err) {
      this.logger.error('syncMlOrderReservations failed', err)
    }
  }
}
