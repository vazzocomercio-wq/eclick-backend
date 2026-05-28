import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Headers,
  UseGuards, BadRequestException, UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import { AffiliatesService, type AffiliateSettings } from './affiliates.service'
import { AffiliateAttributionService } from './affiliate-attribution.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../common/supabase'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * ── ADMIN (lojista) ──
 *   GET/PATCH  /affiliates/settings
 *   GET        /affiliates                          ?status=&limit=&offset=
 *   GET        /affiliates/:id
 *   POST       /affiliates/:id/approve
 *   POST       /affiliates/:id/reject               { reason? }
 *   POST       /affiliates/:id/suspend
 *   PATCH      /affiliates/:id/commission           { custom_commission_pct }
 *   GET        /affiliates/commissions              ?status=&limit=&offset=
 *   POST       /affiliates/commissions/:id/mark-paid { notes? }
 *   POST       /affiliates/commissions/:id/reject    { reason }
 */
@Controller('affiliates')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class AffiliatesAdminController {
  constructor(
    private readonly svc: AffiliatesService,
    private readonly attribution: AffiliateAttributionService,
  ) {}

  @Get('settings')
  @RequirePermission('store.view')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(u.orgId)
  }

  @Patch('settings')
  @RequirePermission('store.update')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: Partial<AffiliateSettings>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(u.orgId, body)
  }

  @Get()
  @RequirePermission('store.view')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId, {
      status,
      limit:  limit  ? parseInt(limit,  10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  }

  @Get('commissions')
  @RequirePermission('store.view')
  listCommissions(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listOrgCommissions(u.orgId, {
      status,
      limit:  limit  ? parseInt(limit,  10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  }

  @Get(':id')
  @RequirePermission('store.view')
  getById(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getById(u.orgId, id)
  }

  @Post(':id/approve')
  @RequirePermission('store.update')
  approve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approve(u.orgId, id)
  }

  @Post(':id/reject')
  @RequirePermission('store.update')
  reject(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { reason?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.reject(u.orgId, id, body?.reason)
  }

  @Post(':id/suspend')
  @RequirePermission('store.update')
  suspend(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.suspend(u.orgId, id)
  }

  @Patch(':id/commission')
  @RequirePermission('store.update')
  updateCommission(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { custom_commission_pct: number | null }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateCustomCommission(u.orgId, id, body.custom_commission_pct)
  }

  @Post('commissions/:id/mark-paid')
  @RequirePermission('financeiro.reconcile')
  markPaid(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { notes?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.markCommissionPaid(u.orgId, id, body?.notes)
  }

  @Post('commissions/:id/reject')
  @RequirePermission('financeiro.reconcile')
  rejectCommission(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: { reason: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.reason) throw new BadRequestException('reason obrigatório')
    return this.svc.rejectCommission(u.orgId, id, body.reason)
  }

  /** POST /affiliates/cron/approve-expired — trigger manual do cron. */
  @Post('cron/approve-expired')
  @RequirePermission('store.update')
  approveExpired() {
    return this.attribution.approveExpiredCommissions()
  }
}

/**
 * ── PÚBLICO (vitrine + afiliado logado) ──
 *   POST /public/affiliate/by-slug/:slug/track
 *        { code, referrerUrl?, landingUrl?, customerEmail?, customerId? }
 *   POST /public/affiliate/by-slug/:slug/signup
 *   POST /public/affiliate/by-slug/:slug/login
 *   GET  /public/affiliate/me                       (Bearer affiliate token)
 *   PATCH /public/affiliate/me                      (atualiza dados próprios)
 *   GET  /public/affiliate/me/stats
 *   GET  /public/affiliate/me/commissions
 *   GET  /public/affiliate/by-slug/:slug/check/:code (verifica se code existe + active)
 */
@Controller('public/affiliate')
export class AffiliatesPublicController {
  constructor(
    private readonly svc: AffiliatesService,
    private readonly attribution: AffiliateAttributionService,
  ) {}

  @Post('by-slug/:slug/track')
  @Public()
  async track(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Body() body: {
      code?: string
      referrerUrl?: string
      landingUrl?: string
      customerEmail?: string
      customerId?: string
    },
  ) {
    if (!body?.code) throw new BadRequestException('code obrigatório')
    // IP: x-forwarded-for (atrás de proxy) ou socket
    const fwd = req.headers['x-forwarded-for']
    const ip = (Array.isArray(fwd) ? fwd[0] : (fwd ?? '')).toString().split(',')[0].trim()
            || req.socket.remoteAddress
            || undefined
    return this.attribution.trackClick({
      slug,
      code:          body.code,
      referrerUrl:   body.referrerUrl,
      landingUrl:    body.landingUrl,
      userAgent:     req.headers['user-agent'] ?? undefined,
      ip,
      customerEmail: body.customerEmail,
      customerId:    body.customerId,
    })
  }

  @Get('by-slug/:slug/check/:code')
  @Public()
  async check(@Param('slug') slug: string, @Param('code') code: string) {
    const { data: store } = await supabaseAdmin
      .from('store_config').select('organization_id, affiliate_settings')
      .eq('store_slug', slug).eq('status', 'active').maybeSingle()
    if (!store) return { valid: false }
    const settings = (store as { affiliate_settings?: Record<string, unknown> | null }).affiliate_settings
    if (!settings || (settings as { enabled?: boolean }).enabled !== true) return { valid: false }

    const { data: aff } = await supabaseAdmin
      .from('affiliates').select('id, name, status')
      .eq('organization_id', (store as { organization_id: string }).organization_id)
      .eq('code', code.toLowerCase()).maybeSingle()
    if (!aff || (aff as { status: string }).status !== 'approved') return { valid: false }
    return {
      valid: true,
      name: (aff as { name: string }).name,
    }
  }

  @Post('by-slug/:slug/signup')
  @Public()
  async signup(
    @Param('slug') slug: string,
    @Body() body: { name?: string; email?: string; password?: string; phone?: string; doc?: string; code?: string },
  ) {
    const orgId = await this.resolveOrg(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    if (!body?.name || !body?.email || !body?.password) {
      throw new BadRequestException('name, email e password obrigatórios')
    }
    return this.svc.signup(orgId, {
      name:     body.name,
      email:    body.email,
      password: body.password,
      phone:    body.phone,
      doc:      body.doc,
      code:     body.code,
    })
  }

  @Post('by-slug/:slug/login')
  @Public()
  async login(@Param('slug') slug: string, @Body() body: { email?: string; password?: string }) {
    const orgId = await this.resolveOrg(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    if (!body?.email || !body?.password) throw new BadRequestException('email e password obrigatórios')
    return this.svc.login(orgId, { email: body.email, password: body.password })
  }

  @Get('me')
  @Public()
  async me(@Headers('authorization') auth?: string) {
    const token = extractToken(auth)
    return this.svc.getByToken(token)
  }

  @Patch('me')
  @Public()
  async updateMe(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { name?: string; phone?: string | null; doc?: string | null; payout_method?: string | null; payout_details?: Record<string, unknown> | null },
  ) {
    const token = extractToken(auth)
    const cur = await this.svc.getByToken(token)
    return this.svc.updateSelf(cur.id, body)
  }

  @Get('me/stats')
  @Public()
  async myStats(@Headers('authorization') auth?: string) {
    const token = extractToken(auth)
    const cur = await this.svc.getByToken(token)
    return this.svc.getStats(cur.id)
  }

  @Get('me/commissions')
  @Public()
  async myCommissions(
    @Headers('authorization') auth: string | undefined,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    const token = extractToken(auth)
    const cur = await this.svc.getByToken(token)
    return this.svc.listAffiliateCommissions(cur.id, {
      limit:  limit  ? parseInt(limit,  10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  }

  private async resolveOrg(slug: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('store_config').select('organization_id')
      .eq('store_slug', slug).eq('status', 'active').maybeSingle()
    return (data?.organization_id as string) ?? null
  }
}

function extractToken(auth?: string): string {
  if (!auth || !auth.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token obrigatório')
  return auth.slice(7).trim()
}
