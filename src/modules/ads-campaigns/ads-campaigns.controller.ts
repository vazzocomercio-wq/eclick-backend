import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, BadRequestException,
  HttpCode, HttpStatus, Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { AdsCampaignsService } from './ads-campaigns.service'
import { MetaAdsService } from './meta-ads.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import type {
  AdsPlatform, AdsObjective, AdsStatus, AdCopy,
} from './ads-campaigns.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 3 / S4 — Ads Hub endpoints (12).
 *
 * POST   /ads/products/:id/generate-campaign
 * POST   /ads/campaigns
 * GET    /ads/campaigns
 * GET    /ads/campaigns/:id
 * PATCH  /ads/campaigns/:id
 * POST   /ads/campaigns/:id/regenerate-copy
 * POST   /ads/campaigns/:id/add-variant
 * POST   /ads/campaigns/:id/mark-ready    (Sprint 6 = publicar real)
 * POST   /ads/campaigns/:id/pause
 * POST   /ads/campaigns/:id/resume
 * DELETE /ads/campaigns/:id               (= archive)
 * GET    /ads/campaigns/:id/metrics
 * GET    /ads/dashboard
 */
@Controller('ads')
@UseGuards(SupabaseAuthGuard)
export class AdsCampaignsController {
  constructor(
    private readonly svc:     AdsCampaignsService,
    private readonly metaAds: MetaAdsService,
  ) {}

  // ── OAuth Meta Ads (Sprint 6) ────────────────────────────────────

  /** GET /ads/meta/connect */
  @Get('meta/connect')
  metaConnect(
    @ReqUser() u: ReqUserPayload,
    @Query('redirect_to') redirectTo?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.metaAds.buildAuthorizeUrl(u.orgId, u.id, redirectTo)
  }

  /** GET /ads/meta/callback (Public — Meta chama) */
  @Get('meta/callback')
  @Public()
  async metaCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    if (!code || !state) throw new BadRequestException('code/state ausentes')
    const r = await this.metaAds.exchangeCode(code, state)
    const frontendBase = process.env.FRONTEND_URL ?? 'https://eclick.app.br'
    const target = r.redirect_to
      ? `${frontendBase}${r.redirect_to.startsWith('/') ? '' : '/'}${r.redirect_to}`
      : `${frontendBase}/dashboard/ads?meta_connected=1`
    return res.redirect(target)
  }

  /** POST /ads/meta/disconnect */
  @Post('meta/disconnect')
  @HttpCode(HttpStatus.OK)
  metaDisconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.metaAds.disconnect(u.orgId)
  }

  /** GET /ads/meta/ad-accounts */
  @Get('meta/ad-accounts')
  async metaAdAccounts(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const stored = await this.metaAds.getStoredToken(u.orgId)
    if (!stored?.access_token) throw new BadRequestException('Conecte Meta Ads primeiro')
    return this.metaAds.listAdAccounts(stored.access_token)
  }

  /** POST /ads/meta/select-ad-account */
  @Post('meta/select-ad-account')
  @HttpCode(HttpStatus.OK)
  metaSelectAccount(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { ad_account_id: string },
  ) {
    if (!u.orgId)            throw new BadRequestException('orgId ausente')
    if (!body?.ad_account_id) throw new BadRequestException('ad_account_id obrigatório')
    return this.metaAds.setAdAccount(u.orgId, body.ad_account_id)
  }

  /** GET /ads/meta/status */
  @Get('meta/status')
  async metaStatus(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const stored = await this.metaAds.getStoredToken(u.orgId)
    return {
      configured_globally: this.metaAds.isConfigured(),
      connected:           Boolean(stored?.access_token),
      ad_account_id:       stored?.ad_account_id ?? null,
      expires_at:          stored?.expires_at ?? null,
    }
  }

  // ── Ads Campaigns (todas autenticadas) ───────────────────────────

  /** POST /ads/products/:id/generate-campaign */
  @Post('products/:id/generate-campaign')
  @HttpCode(HttpStatus.OK)
  generate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') productId: string,
    @Body() body: { platform: AdsPlatform; objective: AdsObjective },
  ) {
    if (!u.orgId)          throw new BadRequestException('orgId ausente')
    if (!body?.platform)   throw new BadRequestException('platform obrigatório')
    if (!body?.objective)  throw new BadRequestException('objective obrigatório')
    return this.svc.generateForProduct({
      orgId:     u.orgId,
      userId:    u.id,
      productId,
      platform:  body.platform,
      objective: body.objective,
    })
  }

  /** POST /ads/campaigns — manual */
  @Post('campaigns')
  create(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      platform:         AdsPlatform
      name:             string
      objective:        AdsObjective
      targeting?:       Record<string, unknown>
      budget_daily_brl: number
      budget_total_brl?: number
      duration_days?:   number
      bid_strategy?:    string
      ad_copies?:       AdCopy[]
      destination_url?: string
      utm_params?:      Record<string, string>
      product_id?:      string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, u.id, body)
  }

  /** GET /ads/campaigns?platform=&status=&product_id=&limit=&offset= */
  @Get('campaigns')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('platform')   platform?:  AdsPlatform,
    @Query('status')     status?:    AdsStatus,
    @Query('product_id') productId?: string,
    @Query('limit')      limitRaw?:  string,
    @Query('offset')     offsetRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId, {
      platform, status, productId,
      limit:  limitRaw  ? parseInt(limitRaw, 10)  : undefined,
      offset: offsetRaw ? parseInt(offsetRaw, 10) : undefined,
    })
  }

  /** GET /ads/dashboard */
  @Get('dashboard')
  dashboard(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.dashboard(u.orgId)
  }

  /** GET /ads/campaigns/:id */
  @Get('campaigns/:id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(id, u.orgId)
  }

  /** PATCH /ads/campaigns/:id */
  @Patch('campaigns/:id')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(id, u.orgId, body)
  }

  /** POST /ads/campaigns/:id/regenerate-copy */
  @Post('campaigns/:id/regenerate-copy')
  @HttpCode(HttpStatus.OK)
  regenerateCopy(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { instruction: string },
  ) {
    if (!u.orgId)              throw new BadRequestException('orgId ausente')
    if (!body?.instruction)    throw new BadRequestException('instruction obrigatório')
    return this.svc.regenerateCopies(id, u.orgId, body.instruction)
  }

  /** POST /ads/campaigns/:id/add-variant */
  @Post('campaigns/:id/add-variant')
  @HttpCode(HttpStatus.OK)
  addVariant(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { variant?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.addVariant(id, u.orgId, body?.variant)
  }

  /** POST /ads/campaigns/:id/mark-ready  (Sprint 6 fará publish real) */
  @Post('campaigns/:id/mark-ready')
  @HttpCode(HttpStatus.OK)
  markReady(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.markReady(id, u.orgId)
  }

  /** POST /ads/campaigns/:id/pause */
  @Post('campaigns/:id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.pause(id, u.orgId)
  }

  /** POST /ads/campaigns/:id/resume */
  @Post('campaigns/:id/resume')
  @HttpCode(HttpStatus.OK)
  resume(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.resume(id, u.orgId)
  }

  /** DELETE /ads/campaigns/:id (= archive) */
  @Delete('campaigns/:id')
  archive(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.archive(id, u.orgId)
  }

  /** GET /ads/campaigns/:id/metrics */
  @Get('campaigns/:id/metrics')
  metrics(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getMetrics(id, u.orgId)
  }

  /** POST /ads/campaigns/:id/publish (Sprint 6) */
  @Post('campaigns/:id/publish')
  @HttpCode(HttpStatus.OK)
  publish(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.publish(id, u.orgId)
  }

  /** POST /ads/campaigns/:id/sync-metrics */
  @Post('campaigns/:id/sync-metrics')
  @HttpCode(HttpStatus.OK)
  syncMetrics(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.syncMetrics(id, u.orgId)
  }
}
