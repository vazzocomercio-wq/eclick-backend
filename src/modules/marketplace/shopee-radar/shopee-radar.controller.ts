import {
  Controller, Get, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeRadarService } from './shopee-radar.service'
import { SignalType } from './shopee-radar.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F1.5 — Radar Shopee endpoints. READ-ONLY (Sprint 2 adiciona POST). */
@Controller('shopee/radar')
@UseGuards(SupabaseAuthGuard)
export class ShopeeRadarController {
  constructor(private readonly svc: ShopeeRadarService) {}

  /** GET /shopee/radar/signals — resumo agrupado por tipo (alimenta dashboard). */
  @Get('signals')
  async signals(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.summary(user.orgId)
  }

  /** GET /shopee/radar/by-type?type=trending&category_id=N */
  @Get('by-type')
  async byType(
    @ReqUser() user: ReqUserPayload,
    @Query('type')        typeRaw?:     string,
    @Query('category_id') categoryRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!isType(typeRaw)) throw new BadRequestException('type inválido')
    const categoryId = categoryRaw ? Number(categoryRaw) : undefined
    if (categoryRaw && !Number.isFinite(categoryId)) {
      throw new BadRequestException('category_id inválido')
    }
    const items = await this.svc.listByType(user.orgId, typeRaw, categoryId)
    return { items, total: items.length }
  }
}

function isType(s: string | undefined): s is SignalType {
  return s === 'trending' || s === 'price_benchmark' || s === 'fbs_adoption'
}
