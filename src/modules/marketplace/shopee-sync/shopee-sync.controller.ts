import {
  Controller, Post, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F0.7 — Trigger manual do sync de produtos Shopee.
 *
 *  POST /shopee/sync/products → puxa anúncios reais da loja conectada da org e
 *  recomputa os Algorithm Scores (alimenta o Listing Center com dado real).
 *  Idempotente no efeito visível (re-sync = novo snapshot; view pega o último). */
@Controller('shopee/sync')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeSyncController {
  constructor(private readonly svc: ShopeeProductSyncService) {}

  @Post('products')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async syncProducts(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.syncProducts(user.orgId)
  }
}
