import {
  Controller, Get, Post, Body, Query, UseGuards, BadRequestException,
  Param, HttpCode, HttpStatus, Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { SocialCommerceService } from './social-commerce.service'
import { MetaCatalogService } from './meta-catalog.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 3 / S2 — Social Commerce endpoints (Instagram/Facebook Shop sync).
 *
 *  ── OAuth (Instagram/Facebook via Meta) ────────────────────────
 *  GET   /social-commerce/instagram/connect       (auth)
 *  GET   /social-commerce/instagram/callback      (public — Meta chama)
 *  POST  /social-commerce/instagram/disconnect    (auth)
 *
 *  ── Setup ──────────────────────────────────────────────────────
 *  GET   /social-commerce/instagram/status        (auth)
 *  GET   /social-commerce/instagram/pages         (auth)  → pra wizard
 *  GET   /social-commerce/instagram/catalogs      (auth)  → pra wizard
 *  POST  /social-commerce/instagram/setup-catalog (auth)
 *
 *  ── Sync ───────────────────────────────────────────────────────
 *  POST  /social-commerce/instagram/sync          (auth)  → bulk
 *  POST  /social-commerce/instagram/sync-product/:id (auth)
 *
 *  ── Produtos no canal ──────────────────────────────────────────
 *  GET   /social-commerce/instagram/products      (auth)
 *  POST  /social-commerce/instagram/products/add  (auth)
 *  POST  /social-commerce/instagram/products/remove (auth)
 */
@Controller('social-commerce')
export class SocialCommerceController {
  constructor(
    private readonly svc:  SocialCommerceService,
    private readonly meta: MetaCatalogService,
  ) {}

  // ── OAuth ───────────────────────────────────────────────────────

  /** GET /social-commerce/instagram/connect — gera authorize_url e
   *  retorna ao frontend pra window.location.href. */
  @Get('instagram/connect')
  @UseGuards(SupabaseAuthGuard)
  connect(
    @ReqUser() u: ReqUserPayload,
    @Query('redirect_to') redirectTo?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.meta.buildAuthorizeUrl(u.orgId, u.id, redirectTo)
  }

  /** GET /social-commerce/instagram/callback?code=&state= — Meta chama. */
  @Get('instagram/callback')
  @Public()
  async callback(
    @Query('code')  code:  string,
    @Query('state') state: string,
    @Res() res:     Response,
  ) {
    if (!code)  throw new BadRequestException('code ausente')
    if (!state) throw new BadRequestException('state ausente')

    const result = await this.meta.exchangeCode(code, state)
    const frontendBase = process.env.FRONTEND_URL ?? 'https://eclick.app.br'
    const target = result.redirect_to
      ? `${frontendBase}${result.redirect_to.startsWith('/') ? '' : '/'}${result.redirect_to}`
      : `${frontendBase}/dashboard/social-commerce/instagram?connected=1`
    return res.redirect(target)
  }

  /** POST /social-commerce/instagram/disconnect */
  @Post('instagram/disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  disconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.disconnect(u.orgId, 'instagram_shop')
  }

  // ── Setup ────────────────────────────────────────────────────────

  /** GET /social-commerce/instagram/status — info pra UI */
  @Get('instagram/status')
  @UseGuards(SupabaseAuthGuard)
  async status(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const ch = await this.svc.getStatus(u.orgId, 'instagram_shop')
    return {
      configured_globally: this.meta.isConfigured(),
      connected:           ch?.status === 'connected',
      channel:             ch ? {
        id:                ch.id,
        status:            ch.status,
        external_account_id: ch.external_account_id,
        external_catalog_id: ch.external_catalog_id,
        config:              ch.config,
        last_sync_at:        ch.last_sync_at,
        last_error:          ch.last_error,
        products_synced:     ch.products_synced,
        sync_errors:         ch.sync_errors,
      } : null,
    }
  }

  /** GET /social-commerce/instagram/pages */
  @Get('instagram/pages')
  @UseGuards(SupabaseAuthGuard)
  pages(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listAvailablePages(u.orgId)
  }

  /** GET /social-commerce/instagram/catalogs */
  @Get('instagram/catalogs')
  @UseGuards(SupabaseAuthGuard)
  catalogs(
    @ReqUser() u: ReqUserPayload,
    @Query('business_id') businessId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listAvailableCatalogs(u.orgId, businessId)
  }

  /** POST /social-commerce/instagram/setup-catalog */
  @Post('instagram/setup-catalog')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  setup(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      page_id:               string
      instagram_account_id?: string
      catalog_id:            string
      pixel_id?:             string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setupCatalog(u.orgId, body)
  }

  // ── Sync ─────────────────────────────────────────────────────────

  /** POST /social-commerce/instagram/sync */
  @Post('instagram/sync')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  syncAll(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.syncAll(u.orgId)
  }

  /** POST /social-commerce/instagram/sync-product/:id */
  @Post('instagram/sync-product/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  syncProduct(
    @ReqUser() u: ReqUserPayload,
    @Param('id') productId: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.syncProduct(u.orgId, productId)
  }

  // ── Produtos no canal ────────────────────────────────────────────

  /** GET /social-commerce/instagram/products */
  @Get('instagram/products')
  @UseGuards(SupabaseAuthGuard)
  listProducts(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listSyncedProducts(u.orgId, 'instagram_shop')
  }

  /** POST /social-commerce/instagram/products/add */
  @Post('instagram/products/add')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  addProducts(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { product_ids: string[] },
  ) {
    if (!u.orgId)                    throw new BadRequestException('orgId ausente')
    if (!body?.product_ids?.length)  throw new BadRequestException('product_ids obrigatório')
    return this.svc.addProductsToSync(u.orgId, 'instagram_shop', body.product_ids)
  }

  /** POST /social-commerce/instagram/products/remove */
  @Post('instagram/products/remove')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  removeProducts(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { product_ids: string[] },
  ) {
    if (!u.orgId)                    throw new BadRequestException('orgId ausente')
    if (!body?.product_ids?.length)  throw new BadRequestException('product_ids obrigatório')
    return this.svc.removeProductsFromSync(u.orgId, 'instagram_shop', body.product_ids)
  }
}
