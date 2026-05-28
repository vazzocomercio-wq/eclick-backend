import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { StoreConfigService, THEME_PRESETS, type StoreConfig } from './store-config.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

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
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StoreConfigController {
  constructor(private readonly svc: StoreConfigService) {}

  @Get()
  @RequirePermission('store.view')
  get(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(u.orgId)
  }

  @Post()
  @RequirePermission('store.update')
  create(@ReqUser() u: ReqUserPayload, @Body() body: { store_name: string; store_slug?: string }) {
    if (!u.orgId)             throw new BadRequestException('orgId ausente')
    if (!body?.store_name)    throw new BadRequestException('store_name obrigatório')
    return this.svc.getOrCreate(u.orgId, body)
  }

  @Patch()
  @RequirePermission('store.update')
  update(@ReqUser() u: ReqUserPayload, @Body() body: Partial<StoreConfig>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, body)
  }

  @Post('verify-domain')
  @RequirePermission('store.update')
  verifyDomain(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.verifyDomain(u.orgId)
  }

  @Get('theme-presets')
  @RequirePermission('store.view')
  themePresets() {
    return THEME_PRESETS
  }

  // ── Promoções por produto ─────────────────────────────────────────────
  // GET    /store/config/promotions?filter=active|scheduled|expired|none|all&q=&limit=&offset=
  // PATCH  /store/config/promotions/:productId
  // PATCH  /store/config/promotions/bulk

  @Get('promotions')
  @RequirePermission('store.view')
  listPromotions(
    @ReqUser() u: ReqUserPayload,
    @Query('filter') filter?: string,
    @Query('q')      q?:      string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const validFilters = ['all', 'active', 'scheduled', 'expired', 'none'] as const
    const safeFilter = (validFilters as readonly string[]).includes(filter ?? 'all')
      ? (filter as typeof validFilters[number])
      : 'all'
    return this.svc.listProductsForPromotionAdmin(u.orgId, {
      filter: safeFilter,
      q,
      limit:  limit  ? parseInt(limit,  10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  }

  @Patch('promotions/:productId')
  @RequirePermission('store.update')
  setPromotion(
    @ReqUser() u: ReqUserPayload,
    @Param('productId') productId: string,
    @Body() body: {
      sale_price?: number | null
      sale_start_at?: string | null
      sale_end_at?: string | null
      sale_badge_text?: string | null
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.setProductPromotion(u.orgId, productId, body)
  }

  @Patch('promotions/bulk/metadata')
  @RequirePermission('store.update')
  bulkSetPromotionMetadata(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      productIds: string[]
      sale_start_at?: string | null
      sale_end_at?: string | null
      sale_badge_text?: string | null
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.productIds)) throw new BadRequestException('productIds[] obrigatório')
    return this.svc.bulkSetPromotionMetadata(u.orgId, body.productIds, body)
  }

  /** POST /store/config/promotions/bulk-apply
   *  Body: { productIds[], discountPct? | salePrice?, startAt?, endAt?, badgeText? }
   *  Aplica desconto linear (% calcula por produto, salePrice fixo idem em todos). */
  @Post('promotions/bulk-apply')
  @RequirePermission('store.update')
  bulkApplyDiscount(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      productIds:   string[]
      discountPct?: number
      salePrice?:   number
      startAt?:     string | null
      endAt?:       string | null
      badgeText?:   string | null
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.productIds) || body.productIds.length === 0) {
      throw new BadRequestException('productIds[] obrigatório')
    }
    return this.svc.bulkApplyDiscount(u.orgId, body)
  }

  /** POST /store/config/promotions/bulk-clear — remove promoção de N produtos */
  @Post('promotions/bulk-clear')
  @RequirePermission('store.update')
  bulkClearPromotions(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { productIds: string[] },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!Array.isArray(body?.productIds)) throw new BadRequestException('productIds[] obrigatório')
    return this.svc.bulkClearPromotions(u.orgId, body.productIds)
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
    @Query('limit')      limitRaw?:    string,
    @Query('offset')     offsetRaw?:   string,
    @Query('category')   category?:    string,
    @Query('categoryMlId') categoryMlIdRaw?: string,  // 1 folha ou várias (csv) — filtro por categoria ML
  ) {
    const config = await this.svc.getPublicBySlugOrDomain({ slug })
    if (!config) return { config: null, products: [] }
    const categoryMlIds = categoryMlIdRaw
      ? categoryMlIdRaw.split(',').map(s => s.trim()).filter(Boolean)
      : undefined
    const products = await this.svc.listPublicProducts(config.organization_id, {
      limit:  limitRaw  ? parseInt(limitRaw, 10)  : undefined,
      offset: offsetRaw ? parseInt(offsetRaw, 10) : undefined,
      category,
      categoryMlIds,
    })
    return { config, products }
  }

  /** Cat-2 — categorias da vitrine (só as que têm produto; vazia = oculta).
   *  Resolve nome/caminho contra o espelho ml_categories. SÓ LEITURA. */
  @Get(':slug/categories')
  @Public()
  async categories(@Param('slug') slug: string) {
    const config = await this.svc.getPublicBySlugOrDomain({ slug })
    if (!config) return { groups: [] }
    return this.svc.listPublicCategories(config.organization_id)
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
