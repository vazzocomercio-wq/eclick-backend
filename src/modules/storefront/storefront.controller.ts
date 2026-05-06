import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import { StorefrontService, type StorefrontRule, type ProductCollection } from './storefront.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 4 / A2 — Storefront.
 *
 * RULES (auth):
 *   GET    /storefront/rules
 *   POST   /storefront/rules
 *   PATCH  /storefront/rules/:id
 *   DELETE /storefront/rules/:id
 *
 * PERSONALIZE (public — chamado pelo storefront):
 *   GET    /storefront/personalize?org=&utm_source=&device=...
 *
 * COLLECTIONS (auth):
 *   GET    /collections
 *   POST   /collections
 *   GET    /collections/:id
 *   PATCH  /collections/:id
 *   DELETE /collections/:id
 *   POST   /collections/generate
 *
 * COLLECTION PRODUCTS (public):
 *   GET    /collections/:slug/products?org=...
 */

// Auth controller
@Controller('storefront')
@UseGuards(SupabaseAuthGuard)
export class StorefrontController {
  constructor(private readonly svc: StorefrontService) {}

  @Get('rules')
  listRules(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listRules(u.orgId)
  }

  @Post('rules')
  createRule(@ReqUser() u: ReqUserPayload, @Body() body: Partial<StorefrontRule>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createRule(u.orgId, body)
  }

  @Patch('rules/:id')
  updateRule(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<StorefrontRule>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateRule(id, u.orgId, body)
  }

  @Delete('rules/:id')
  deleteRule(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteRule(id, u.orgId)
  }
}

// Public personalize (não usa auth — chamado pelo storefront SSR/edge)
@Controller('storefront-public')
export class StorefrontPublicController {
  constructor(private readonly svc: StorefrontService) {}

  @Get('personalize')
  @Public()
  personalize(
    @Query('org')              orgId:           string,
    @Query('utm_source')       utm_source?:     string,
    @Query('utm_medium')       utm_medium?:     string,
    @Query('utm_campaign')     utm_campaign?:   string,
    @Query('utm_content')      utm_content?:    string,
    @Query('referrer')         referrer?:       string,
    @Query('device')           device?:         'mobile' | 'desktop',
    @Query('geo_state')        geo_state?:      string,
    @Query('visited_category') visited_category?: string,
    @Query('returning')        returningRaw?:   string,
    @Query('hour')             hourRaw?:        string,
  ) {
    if (!orgId) throw new BadRequestException('org obrigatório')
    return this.svc.personalize(orgId, {
      utm_source, utm_medium, utm_campaign, utm_content,
      referrer, device, geo_state, visited_category,
      returning: returningRaw === 'true',
      hour: hourRaw ? parseInt(hourRaw, 10) : undefined,
    })
  }
}

// Collections (auth)
@Controller('collections')
@UseGuards(SupabaseAuthGuard)
export class CollectionsController {
  constructor(private readonly svc: StorefrontService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listCollections(u.orgId)
  }

  @Post()
  create(@ReqUser() u: ReqUserPayload, @Body() body: Partial<ProductCollection>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createCollection(u.orgId, body)
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  generate(@ReqUser() u: ReqUserPayload, @Body() body: { count?: number } = {}) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateCollections(u.orgId, body.count ?? 5)
  }

  @Get(':id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCollection(id, u.orgId)
  }

  @Patch(':id')
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<ProductCollection>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateCollection(id, u.orgId, body)
  }

  @Delete(':id')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteCollection(id, u.orgId)
  }
}

// Collections public (lista produtos por slug)
@Controller('collections-public')
export class CollectionsPublicController {
  constructor(private readonly svc: StorefrontService) {}

  @Get(':slug/products')
  @Public()
  products(
    @Param('slug') slug: string,
    @Query('org')  orgId: string,
  ) {
    if (!orgId) throw new BadRequestException('org obrigatório')
    return this.svc.listCollectionProducts(orgId, slug)
  }
}
