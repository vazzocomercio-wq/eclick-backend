import {
  Controller, Get, Post, Patch, Body, Query, Param, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { ShopeeAffiliateService } from './shopee-affiliate.service'
import { LinkStudioService } from './link-studio.service'
import { AttributionService } from './attribution.service'
import { ContentStudioService } from './content-studio.service'
import { ShopeeRadarService } from './shopee-radar.service'
import { ShopeeAffiliateApiService } from './shopee-affiliate-api.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 Fase 2 — Discovery / Link Studio / Attribution / Content Studio + Radar de Campeões. */
@Controller('shopee-affiliate')
@UseGuards(SupabaseAuthGuard)
export class ShopeeAffiliateController {
  constructor(
    private readonly svc:         ShopeeAffiliateService,
    private readonly linkStudio:  LinkStudioService,
    private readonly attribution: AttributionService,
    private readonly content:     ContentStudioService,
    private readonly radar:       ShopeeRadarService,
    private readonly affApi:      ShopeeAffiliateApiService,
  ) {}

  // ── Radar de Produtos Campeões (Sprint 2) ─────────────────────────────────

  /** GET /shopee-affiliate/radar/status — Affiliate API conectada? */
  @Get('radar/status')
  async radarStatus(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return { connected: await this.affApi.hasCreds(user.orgId) }
  }

  /** GET /shopee-affiliate/radar/settings — auto diário + keywords salvas. */
  @Get('radar/settings')
  radarSettings(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.radar.getSettings(user.orgId)
  }

  /** PATCH /shopee-affiliate/radar/settings { auto?, keywords? } */
  @Patch('radar/settings')
  saveRadarSettings(@ReqUser() user: ReqUserPayload, @Body() body: { auto?: boolean; keywords?: string[] }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.radar.saveSettings(user.orgId, {
      auto: typeof body?.auto === 'boolean' ? body.auto : undefined,
      keywords: Array.isArray(body?.keywords) ? body.keywords.filter(Boolean).slice(0, 20) : undefined,
    })
  }

  /** POST /shopee-affiliate/radar/ingest { keywords?, cat_ids?, pages? } — busca produtos reais. */
  @Post('radar/ingest')
  ingest(@ReqUser() user: ReqUserPayload, @Body() body: { keywords?: string[]; cat_ids?: number[]; pages?: number }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.radar.ingest(user.orgId, {
      keywords: Array.isArray(body?.keywords) ? body.keywords.filter(Boolean).slice(0, 20) : undefined,
      catIds:   Array.isArray(body?.cat_ids) ? body.cat_ids.map(Number).filter(Number.isFinite).slice(0, 20) : undefined,
      pagesPerQuery: body?.pages,
    })
  }

  /** GET /shopee-affiliate/radar?decision=&min_score=&limit=&offset= */
  @Get('radar')
  radarList(
    @ReqUser() user: ReqUserPayload,
    @Query('decision') decision?: string,
    @Query('min_score') minScoreRaw?: string,
    @Query('watched') watchedRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('offset') offsetRaw?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const dec = decision && ['comprar', 'observar', 'ignorar'].includes(decision) ? (decision as 'comprar' | 'observar' | 'ignorar') : null
    return this.radar.radar({
      orgId: user.orgId, decision: dec,
      minScore: minScoreRaw != null ? Number(minScoreRaw) : null,
      watched: watchedRaw === 'true',
      limit: clampInt(limitRaw, 50, 1, 200), offset: clampInt(offsetRaw, 0, 0),
    })
  }

  /** POST /shopee-affiliate/radar/product/:itemId/watch { watched } — observar/parar. */
  @Post('radar/product/:itemId/watch')
  watch(@ReqUser() user: ReqUserPayload, @Param('itemId') itemId: string, @Body() body: { watched: boolean }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.radar.setWatch(user.orgId, Number(itemId), body?.watched !== false)
  }

  /** GET /shopee-affiliate/radar/product/:itemId/analytics?days=30 */
  @Get('radar/product/:itemId/analytics')
  radarAnalytics(@ReqUser() user: ReqUserPayload, @Param('itemId') itemId: string, @Query('days') daysRaw?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.radar.productAnalytics(user.orgId, Number(itemId), clampInt(daysRaw, 30, 7, 90))
  }

  /** GET /shopee-affiliate/radar/product/:itemId/affiliate-link — gera link de afiliado. */
  @Get('radar/product/:itemId/affiliate-link')
  radarAffiliateLink(@ReqUser() user: ReqUserPayload, @Param('itemId') itemId: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.radar.affiliateLink(user.orgId, Number(itemId))
  }

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
