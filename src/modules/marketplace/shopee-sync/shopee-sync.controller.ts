import {
  Controller, Post, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ShopeeShopMetricsSyncService } from './shopee-metrics-sync.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F0.7/F1.3 — Triggers manuais dos syncs Shopee.
 *
 *  POST /shopee/sync/products     → anúncios reais → Algorithm Scores (Listing Center).
 *  POST /shopee/sync/shop-metrics → account_health → snapshot do Quality Center
 *                                   (devolve raw_metric_list + errors p/ inspeção).
 *  Idempotente no efeito visível (snapshot por dia / view pega o último). */
@Controller('shopee/sync')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeSyncController {
  constructor(
    private readonly products: ShopeeProductSyncService,
    private readonly metrics:  ShopeeShopMetricsSyncService,
  ) {}

  @Post('products')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncProducts(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.products.syncProducts(user.orgId)
  }

  @Post('shop-metrics')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncShopMetrics(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.metrics.syncShopMetrics(user.orgId)
  }
}
