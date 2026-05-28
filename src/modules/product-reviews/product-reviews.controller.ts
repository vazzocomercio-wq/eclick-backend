import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, Headers, UseGuards,
  BadRequestException, UnauthorizedException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { Public } from '../../common/decorators/public.decorator'
import { supabaseAdmin } from '../../common/supabase'
import { ProductReviewsService } from './product-reviews.service'
import { StorefrontCustomersService } from '../storefront-customers/storefront-customers.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** Endpoints do lojista (SaaS auth via Bearer Supabase JWT).
 *
 *   GET    /reviews                 ?status=&productId=&limit=&offset=
 *   GET    /reviews/stats           (contadores pro hub)
 *   GET    /reviews/settings
 *   PUT    /reviews/settings        { auto_approve?, min_body_chars?, ... }
 *   PUT    /reviews/:id/approve
 *   PUT    /reviews/:id/reject      { reason? }
 *   PUT    /reviews/:id/reply       { text }
 *   DELETE /reviews/:id
 */
@Controller('reviews')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ProductReviewsController {
  constructor(private readonly svc: ProductReviewsService) {}

  @Get()
  @RequirePermission('store.view')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status')    status?:    'pending' | 'approved' | 'rejected',
    @Query('productId') productId?: string,
    @Query('limit')     limit?:     string,
    @Query('offset')    offset?:    string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listForOwner(u.orgId, {
      status, productId,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Get('stats')
  @RequirePermission('store.view')
  stats(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.stats(u.orgId)
  }

  @Get('settings')
  @RequirePermission('store.view')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(u.orgId)
  }

  @Put('settings')
  @RequirePermission('store.update')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: {
    auto_approve?:            boolean
    min_body_chars?:          number
    max_photos?:              number
    ask_after_days?:          number
    hide_customer_full_name?: boolean
    invite_enabled?:          boolean
  }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(u.orgId, body)
  }

  @Post('run-invite-tick')
  @RequirePermission('store.update')
  runInviteTick(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.runReviewInviteTick()
  }

  @Put(':id/approve')
  @RequirePermission('store.update')
  approve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approve(u.orgId, id)
  }

  @Put(':id/reject')
  @RequirePermission('store.update')
  reject(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.reject(u.orgId, id, body?.reason)
  }

  @Put(':id/reply')
  @RequirePermission('store.update')
  reply(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { text?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.text?.trim()) throw new BadRequestException('text obrigatório')
    return this.svc.reply(u.orgId, id, body.text)
  }

  @Delete(':id')
  @RequirePermission('store.update')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }
}

/** Endpoints públicos da vitrine + cliente storefront.
 *
 *   GET  /public/store/by-slug/:slug/products/:productId/reviews   (qualquer um — só approved)
 *   GET  /public/store/auth/me/reviews/eligible                    (cliente: o que pode avaliar)
 *   GET  /public/store/auth/me/reviews                             (cliente: minhas reviews)
 *   POST /public/store/auth/me/reviews                             (cliente: cria avaliação)
 *       { orderId, productId, rating, title?, body, photos? }
 */
@Controller('public/store')
export class ProductReviewsPublicController {
  constructor(
    private readonly svc: ProductReviewsService,
    private readonly customers: StorefrontCustomersService,
  ) {}

  @Get('by-slug/:slug/products/:productId/reviews')
  @Public()
  async publicList(
    @Param('slug')      slug:      string,
    @Param('productId') productId: string,
    @Query('limit')     limit?:    string,
    @Query('offset')    offset?:   string,
  ) {
    const orgId = await resolveOrgBySlug(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    return this.svc.listPublicByProduct(orgId, productId, {
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Get('auth/me/reviews/eligible')
  @Public()
  async eligible(@Headers('authorization') auth?: string) {
    const cur = await this.customers.getCurrentByToken(extractToken(auth))
    return this.svc.listEligibleForCustomer(cur.organization_id, cur.id)
  }

  @Get('auth/me/reviews')
  @Public()
  async myReviews(@Headers('authorization') auth?: string) {
    const cur = await this.customers.getCurrentByToken(extractToken(auth))
    return this.svc.listForCustomer(cur.id)
  }

  @Post('auth/me/reviews')
  @Public()
  async createMine(
    @Headers('authorization') auth: string | undefined,
    @Body() body: {
      orderId?:    string
      productId?:  string
      rating?:     number
      title?:      string
      body?:       string
      photos?:     Array<{ url: string; width?: number; height?: number }>
    },
  ) {
    const cur = await this.customers.getCurrentByToken(extractToken(auth))
    if (!body?.orderId)   throw new BadRequestException('orderId obrigatório')
    if (!body?.productId) throw new BadRequestException('productId obrigatório')
    if (typeof body.rating !== 'number') throw new BadRequestException('rating obrigatório (1-5)')
    if (!body?.body?.trim()) throw new BadRequestException('body obrigatório')

    return this.svc.createForCustomer({
      orgId:      cur.organization_id,
      customerId: cur.id,
      orderId:    body.orderId,
      productId:  body.productId,
      rating:     body.rating,
      title:      body.title,
      body:       body.body,
      photos:     body.photos,
    })
  }
}

async function resolveOrgBySlug(slug: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('store_config')
    .select('organization_id')
    .eq('store_slug', slug)
    .eq('status', 'active')
    .maybeSingle()
  return (data?.organization_id as string) ?? null
}

function extractToken(auth?: string): string {
  if (!auth || !auth.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token obrigatório')
  return auth.slice(7).trim()
}
