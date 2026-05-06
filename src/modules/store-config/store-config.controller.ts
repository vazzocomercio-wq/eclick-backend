import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { StoreConfigService, THEME_PRESETS, type StoreConfig } from './store-config.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 4 / A6 — Store Config (white-label).
 *
 * Auth (admin):
 *   GET    /store/config
 *   POST   /store/config           (create on first call)
 *   PATCH  /store/config
 *   POST   /store/config/verify-domain
 *   GET    /store/config/theme-presets
 *
 * Public (storefront SSR):
 *   GET    /public/store/by-slug/:slug
 *   GET    /public/store/by-domain
 *   GET    /public/store/:slug/products
 *   GET    /public/store/:slug/product/:productId
 */
@Controller('store/config')
@UseGuards(SupabaseAuthGuard)
export class StoreConfigController {
  constructor(private readonly svc: StoreConfigService) {}

  @Get()
  get(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(u.orgId)
  }

  @Post()
  create(@ReqUser() u: ReqUserPayload, @Body() body: { store_name: string; store_slug?: string }) {
    if (!u.orgId)             throw new BadRequestException('orgId ausente')
    if (!body?.store_name)    throw new BadRequestException('store_name obrigatório')
    return this.svc.getOrCreate(u.orgId, body)
  }

  @Patch()
  update(@ReqUser() u: ReqUserPayload, @Body() body: Partial<StoreConfig>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, body)
  }

  @Post('verify-domain')
  verifyDomain(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.verifyDomain(u.orgId)
  }

  @Get('theme-presets')
  themePresets() {
    return THEME_PRESETS
  }
}

@Controller('public/store')
export class StorePublicController {
  constructor(private readonly svc: StoreConfigService) {}

  @Get('by-slug/:slug')
  @Public()
  bySlug(@Param('slug') slug: string) {
    return this.svc.getPublicBySlugOrDomain({ slug })
  }

  @Get('by-domain')
  @Public()
  byDomain(@Query('domain') domain: string) {
    if (!domain) throw new BadRequestException('domain obrigatório')
    return this.svc.getPublicBySlugOrDomain({ domain })
  }

  @Get(':slug/products')
  @Public()
  async products(
    @Param('slug') slug: string,
    @Query('limit')    limitRaw?:  string,
    @Query('offset')   offsetRaw?: string,
    @Query('category') category?:  string,
  ) {
    const config = await this.svc.getPublicBySlugOrDomain({ slug })
    if (!config) return { config: null, products: [] }
    const products = await this.svc.listPublicProducts(config.organization_id, {
      limit:  limitRaw  ? parseInt(limitRaw, 10)  : undefined,
      offset: offsetRaw ? parseInt(offsetRaw, 10) : undefined,
      category,
    })
    return { config, products }
  }

  @Get(':slug/product/:productId')
  @Public()
  async product(@Param('slug') slug: string, @Param('productId') productId: string) {
    const config = await this.svc.getPublicBySlugOrDomain({ slug })
    if (!config) return { config: null, product: null }
    const product = await this.svc.getPublicProduct(config.organization_id, productId)
    return { config, product }
  }
}
