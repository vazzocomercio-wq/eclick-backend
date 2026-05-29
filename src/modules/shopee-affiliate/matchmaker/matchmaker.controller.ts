import {
  Controller, Get, Post, Body, Param, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { MatchmakerService } from './matchmaker.service'
import { MatchStatus } from './match-score.types'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 F4.1 — A Ponte (Matchmaker). Vendedor rankeia afiliados por fit +
 *  propõe comissão; afiliado aceita/recusa. */
@Controller('shopee/matchmaker')
@UseGuards(SupabaseAuthGuard)
export class MatchmakerController {
  constructor(private readonly svc: MatchmakerService) {}

  /** GET /shopee/matchmaker/affiliates?category=X&niche=Y — ranking pro vendedor. */
  @Get('affiliates')
  rankAffiliates(
    @ReqUser() user: ReqUserPayload,
    @Query('category') category?: string,
    @Query('niche')    niche?:    string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.rankAffiliatesForProduct({
      orgId:    user.orgId,
      category: category ?? null,
      niche:    niche ?? null,
    })
  }

  /** GET /shopee/matchmaker/offers?status=open — propostas da org. */
  @Get('offers')
  listOffers(
    @ReqUser() user: ReqUserPayload,
    @Query('status') statusRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const status = isStatus(statusRaw) ? statusRaw : undefined
    return this.svc.listOffers(user.orgId, status)
  }

  /** POST /shopee/matchmaker/offers — vendedor propõe match. */
  @Post('offers')
  createOffer(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      seller_shop_id: number; item_id: number; affiliate_profile_id: string
      proposed_commission_pct: number; category?: string; niche?: string
    },
  ) {
    if (!user.orgId)                     throw new BadRequestException('orgId ausente')
    if (body?.affiliate_profile_id == null) throw new BadRequestException('affiliate_profile_id obrigatório')
    if (body?.item_id == null)           throw new BadRequestException('item_id obrigatório')
    return this.svc.createOffer({
      orgId:                 user.orgId,
      sellerShopId:          Number(body.seller_shop_id),
      itemId:                Number(body.item_id),
      affiliateProfileId:    body.affiliate_profile_id,
      proposedCommissionPct: clamp01(Number(body.proposed_commission_pct)),
      category:              body.category ?? null,
      niche:                 body.niche ?? null,
    })
  }

  /** POST /shopee/matchmaker/offers/:id/respond — afiliado aceita/recusa. */
  @Post('offers/:id/respond')
  respond(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { action: 'accept' | 'decline' },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (body?.action !== 'accept' && body?.action !== 'decline') {
      throw new BadRequestException('action deve ser accept ou decline')
    }
    return this.svc.respondOffer(user.orgId, id, body.action)
  }
}

function isStatus(s: string | undefined): s is MatchStatus {
  return s === 'open' || s === 'accepted' || s === 'declined' || s === 'active' || s === 'paused'
}
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}
