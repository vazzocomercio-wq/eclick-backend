import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter, ShopMetricsParsed } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ShopeeQualityService } from '../shopee-quality/shopee-quality.service'
import { ShopMetricsSnapshot } from '../shopee-quality/shopee-quality.types'

/** F18 F1.3 sync — snapshot de métricas da loja (Quality Center).
 *
 *  Puxa account_health (get_shop_performance + get_shop_penalty) via
 *  ShopeeAdapter.getShopMetrics e grava 1 snapshot/dia em shopee.shop_metrics
 *  (upsert por org+shop+data — re-sync no mesmo dia sobrescreve).
 *
 *  O endpoint devolve `raw_metric_list` + `errors` pra inspeção: a 1ª chamada
 *  real confirma os metric_id/units e se o módulo account_health está
 *  autorizado no app (risco nº 1 = error_permission_denied). rating/chat ficam
 *  null (não expostos na Open Platform v2).
 *
 *  Reusa ensureFreshToken do ProductSync (refresh-on-demand) e saveSnapshot do
 *  QualityService (mesma fonte de verdade da tela). */
@Injectable()
export class ShopeeShopMetricsSyncService {
  private readonly logger = new Logger(ShopeeShopMetricsSyncService.name)

  constructor(
    private readonly mp:          MarketplaceService,
    private readonly adapter:     ShopeeAdapter,
    private readonly productSync: ShopeeProductSyncService,
    private readonly quality:     ShopeeQualityService,
  ) {}

  async syncShopMetrics(orgId: string): Promise<{
    shop_id:         number
    snapshot_date:   string
    metrics:         ShopMetricsParsed
    errors:          string[]
    raw_metric_list: unknown
  }> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')

    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    const result = await this.adapter.getShopMetrics(conn)
    const snapshotDate = new Date().toISOString().slice(0, 10)

    const snapshot: ShopMetricsSnapshot = {
      organization_id:        orgId,
      shop_id:                shopId,
      snapshot_date:          snapshotDate,
      penalty_points:         result.metrics.penalty_points,
      late_ship_rate:         result.metrics.late_ship_rate,
      return_refund_rate:     result.metrics.return_refund_rate,
      prep_time_days:         result.metrics.prep_time_days,
      rating:                 result.metrics.rating,
      chat_response_rate:     result.metrics.chat_response_rate,
      chat_response_time_min: result.metrics.chat_response_time_min,
      raw: { performance: result.raw_performance, penalty: result.raw_penalty } as Record<string, unknown>,
      source: 'api',
    }
    await this.quality.saveSnapshot(snapshot)

    this.logger.log(
      `[shopee.metrics] org=${orgId} shop=${shopId} penalty=${result.metrics.penalty_points} ` +
      `late=${result.metrics.late_ship_rate} return=${result.metrics.return_refund_rate} ` +
      `prep=${result.metrics.prep_time_days} errors=${result.errors.length}`,
    )

    return {
      shop_id:       shopId,
      snapshot_date: snapshotDate,
      metrics:       result.metrics,
      errors:        result.errors,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      raw_metric_list: (result.raw_performance as any)?.metric_list ?? null,
    }
  }
}
