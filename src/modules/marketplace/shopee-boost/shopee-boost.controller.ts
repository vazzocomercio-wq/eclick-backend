import {
  Controller, Get, Post, Body, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'
import { ShopeeAutoBoostService, BoostConfig } from './shopee-auto-boost.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 Auto-Boost Inteligente — boost gratuito da Shopee no piloto automático.
 *
 *  GET  /shopee/boost/overview → por loja: config + boosts ativos + candidatos
 *                                ranqueados (racional) + histórico.
 *  POST /shopee/boost/config   → toggle/estratégia/exclusões/rotação por loja.
 *  POST /shopee/boost/run      → 1 ciclo manual (dry_run = só o plano). */
@Controller('shopee/boost')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeBoostController {
  constructor(private readonly boost: ShopeeAutoBoostService) {}

  @Get('overview')
  @RequirePermission('products.view')
  async overview(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.boost.overview(user.orgId)
  }

  @Post('config')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async saveConfig(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { shop_id: number | string } & Partial<BoostConfig>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const shopId = Number(body?.shop_id)
    if (!Number.isFinite(shopId)) throw new BadRequestException('shop_id obrigatório')
    const config = await this.boost.upsertConfig(user.orgId, shopId, {
      enabled:           body.enabled,
      strategy:          body.strategy,
      excluded_item_ids: body.excluded_item_ids,
      max_per_cycle:     body.max_per_cycle,
      rotation_hours:    body.rotation_hours,
    })
    return { shop_id: shopId, config }
  }

  /** Ciclo manual — boost REAL (gratuito, expira em 4h sozinho). Com
   *  dry_run=true devolve só o plano (preview do gate do 1º ciclo). */
  @Post('run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async run(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { shop_id: number | string; dry_run?: boolean },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const shopId = Number(body?.shop_id)
    if (!Number.isFinite(shopId)) throw new BadRequestException('shop_id obrigatório')
    return this.boost.runCycle(user.orgId, shopId, { source: 'manual', dryRun: Boolean(body?.dry_run) })
  }
}
