import {
  Controller, Get, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { ShopeeAffiliateService } from './shopee-affiliate.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F2.1+F2.3 — Discovery do lado Afiliado. READ-ONLY Sprint 1. */
@Controller('shopee-affiliate')
@UseGuards(SupabaseAuthGuard)
export class ShopeeAffiliateController {
  constructor(private readonly svc: ShopeeAffiliateService) {}

  /** GET /shopee-affiliate/status — conexão Affiliate API configurada? */
  @Get('status')
  status(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.connectionStatus(user.orgId)
  }

  /** GET /shopee-affiliate/offers?category=X&min_commission=0.1&include_excluded=false
   *  Ofertas ranqueadas por Opportunity Score. */
  @Get('offers')
  async offers(
    @ReqUser() user: ReqUserPayload,
    @Query('category')         category?:        string,
    @Query('min_commission')   minCommissionRaw?: string,
    @Query('include_excluded') includeExcluded?:  string,
    @Query('limit')            limitRaw?:         string,
    @Query('offset')           offsetRaw?:        string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const minCommission = minCommissionRaw != null ? Number(minCommissionRaw) : null
    if (minCommissionRaw != null && (!Number.isFinite(minCommission) || minCommission! < 0 || minCommission! > 1)) {
      throw new BadRequestException('min_commission deve ser 0-1')
    }
    return this.svc.discoverOffers({
      orgId:           user.orgId,
      category:        category ?? null,
      minCommission,
      includeExcluded: includeExcluded === 'true',
      limit:           clampInt(limitRaw,  50, 1, 200),
      offset:          clampInt(offsetRaw, 0, 0),
    })
  }
}

function clampInt(raw: string | undefined, def: number, min: number, max?: number): number {
  if (raw == null) return def
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return def
  let out = Math.max(min, n)
  if (max != null) out = Math.min(max, out)
  return out
}
