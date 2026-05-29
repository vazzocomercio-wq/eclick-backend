import {
  Controller, Get, Post, Body, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { LinkStudioService } from './link-studio.service'
import { AttributionService } from './attribution.service'
import { ContentStudioService } from './content-studio.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 Fase 2 — Discovery / Link Studio / Attribution / Content Studio. */
@Controller('shopee-affiliate')
@UseGuards(SupabaseAuthGuard)
export class ShopeeAffiliateController {
  constructor(
    private readonly svc:         ShopeeAffiliateService,
    private readonly linkStudio:  LinkStudioService,
    private readonly attribution: AttributionService,
    private readonly content:     ContentStudioService,
  ) {}

  // ── F2.6 Content Studio ───────────────────────────────────────────────

  /** POST /shopee-affiliate/content — gera copy IA + link { item_id, channel, tone? }. */
  @Post('content')
  generateContent(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { item_id: number; channel: string; tone?: string },
  ) {
    if (!user.orgId)           throw new BadRequestException('orgId ausente')
    if (body?.item_id == null) throw new BadRequestException('item_id obrigatório')
    if (!body?.channel)        throw new BadRequestException('channel obrigatório')
    return this.content.generate({ orgId: user.orgId, itemId: Number(body.item_id), channel: body.channel, tone: body.tone })
  }

  // ── F2.5 Attribution ──────────────────────────────────────────────────

  /** GET /shopee-affiliate/conversions/summary — totais + por canal. */
  @Get('conversions/summary')
  conversionsSummary(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.attribution.summary(user.orgId)
  }

  /** GET /shopee-affiliate/conversions?state=pending&channel=whatsapp */
  @Get('conversions')
  conversions(
    @ReqUser() user: ReqUserPayload,
    @Query('state')   state?:   string,
    @Query('channel') channel?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.attribution.list(user.orgId, state, channel)
  }

  // ── F2.4 Link Studio ──────────────────────────────────────────────────

  /** POST /shopee-affiliate/links — gera link rastreável { item_id, channel }. */
  @Post('links')
  generateLink(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { item_id: number; channel: string },
  ) {
    if (!user.orgId)         throw new BadRequestException('orgId ausente')
    if (body?.item_id == null) throw new BadRequestException('item_id obrigatório')
    if (!body?.channel)      throw new BadRequestException('channel obrigatório')
    return this.linkStudio.generate({ orgId: user.orgId, itemId: Number(body.item_id), channel: body.channel })
  }

  /** GET /shopee-affiliate/links?item_id=N — lista links gerados. */
  @Get('links')
  listLinks(
    @ReqUser() user: ReqUserPayload,
    @Query('item_id') itemIdRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const itemId = itemIdRaw ? Number(itemIdRaw) : undefined
    return this.linkStudio.list(user.orgId, itemId)
  }

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
