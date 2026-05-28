import {
  Controller, Get, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeQualityService } from './shopee-quality.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F1.3 — Endpoints do Shopee Quality Center.
 *
 *  Cockpit do frontend lê os snapshots mais recentes por loja + histórico
 *  pra mini-gráficos de tendência. Save snapshot vem da Sprint 2 (sync ou
 *  extension) — não exposto via HTTP por enquanto. */
@Controller('shopee/shop-metrics')
@UseGuards(SupabaseAuthGuard)
export class ShopeeQualityController {
  constructor(private readonly svc: ShopeeQualityService) {}

  /** GET /shopee/shop-metrics/latest
   *  Optional ?shop_id=N pra filtrar; sem filtro = todas lojas da org. */
  @Get('latest')
  async latest(
    @ReqUser() user: ReqUserPayload,
    @Query('shop_id') shopIdRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const shopId = shopIdRaw ? Number(shopIdRaw) : undefined
    if (shopIdRaw && (!Number.isFinite(shopId) || shopId === undefined)) {
      throw new BadRequestException('shop_id inválido')
    }
    const items = await this.svc.getLatest(user.orgId, shopId)
    return { items, total: items.length }
  }

  /** GET /shopee/shop-metrics/history?shop_id=N&days=30
   *  Histórico ASC por snapshot_date (default 30d). */
  @Get('history')
  async history(
    @ReqUser() user: ReqUserPayload,
    @Query('shop_id') shopIdRaw?: string,
    @Query('days')    daysRaw?:   string,
  ) {
    if (!user.orgId)  throw new BadRequestException('orgId ausente')
    if (!shopIdRaw)   throw new BadRequestException('shop_id obrigatório')
    const shopId = Number(shopIdRaw)
    if (!Number.isFinite(shopId)) throw new BadRequestException('shop_id inválido')
    const days = daysRaw ? Math.max(1, Math.min(180, Number(daysRaw))) : 30
    const items = await this.svc.getHistory(user.orgId, shopId, days)
    return { items, total: items.length, days }
  }
}
