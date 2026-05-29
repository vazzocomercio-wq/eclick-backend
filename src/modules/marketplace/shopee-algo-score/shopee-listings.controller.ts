import {
  Controller, Get, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeListingsService, ListingScoreFilters } from './shopee-listings.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F1.2 — Endpoint pra alimentar o Listing Center frontend.
 *
 *  Devolve anúncios Shopee com score mais recente + breakdown + top issues.
 *  Listing Center UI ranqueia por score asc (prioridade = piores primeiro). */
@Controller('shopee/listings')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeListingsController {
  constructor(private readonly svc: ShopeeListingsService) {}

  /** GET /shopee/listings/scores
   *  Query: ?limit=50&offset=0&min_score=0&max_score=100&shop_id=N
   *  Response: { items: ListingScoreCard[], total: number } */
  @Get('scores')
  @RequirePermission('products.view')
  async listScores(
    @ReqUser() user: ReqUserPayload,
    @Query('limit')     limit?:    string,
    @Query('offset')    offset?:   string,
    @Query('min_score') minScore?: string,
    @Query('max_score') maxScore?: string,
    @Query('shop_id')   shopId?:   string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const filters: ListingScoreFilters = {
      orgId:    user.orgId,
      limit:    parseIntOr(limit,    50, { min: 1, max: 200 }),
      offset:   parseIntOr(offset,   0,  { min: 0 }),
      minScore: parseIntOrNull(minScore),
      maxScore: parseIntOrNull(maxScore),
      shopId:   shopId ? Number(shopId) : null,
    }
    return this.svc.listLatestScores(filters)
  }
}

function parseIntOr(
  raw:     string | undefined,
  fallback: number,
  bounds:  { min?: number; max?: number } = {},
): number {
  if (raw == null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  let out = Math.floor(n)
  if (bounds.min != null) out = Math.max(bounds.min, out)
  if (bounds.max != null) out = Math.min(bounds.max, out)
  return out
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.floor(n)))
}
