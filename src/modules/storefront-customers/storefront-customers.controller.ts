import {
  Controller, Post, Get, Patch, Body, Param, Headers,
  BadRequestException, UnauthorizedException,
} from '@nestjs/common'
import { Public } from '../../common/decorators/public.decorator'
import { StorefrontCustomersService, type Address } from './storefront-customers.service'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Endpoints públicos da Loja Própria — accounts de cliente.
 *
 *   POST /public/store/auth/by-slug/:slug/signup    { email, password, name, phone?, doc? }
 *   POST /public/store/auth/by-slug/:slug/login     { email, password }
 *   GET  /public/store/auth/me                      (Bearer token)
 *   PATCH /public/store/auth/me                     { name?, phone?, doc?, addresses?, accepts_marketing? }
 *   GET  /public/store/auth/me/orders               (Bearer token)
 *
 * Auth: Authorization: Bearer <token>  (JWT próprio da loja, HS256).
 */
@Controller('public/store/auth')
export class StorefrontCustomersController {
  constructor(private readonly svc: StorefrontCustomersService) {}

  @Post('by-slug/:slug/signup')
  @Public()
  async signup(
    @Param('slug') slug: string,
    @Body() body: { email?: string; password?: string; name?: string; phone?: string; doc?: string },
  ) {
    const orgId = await this.resolveOrg(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    if (!body?.email || !body?.password || !body?.name) {
      throw new BadRequestException('email, password e name obrigatórios')
    }
    return this.svc.signup(orgId, {
      email:    body.email,
      password: body.password,
      name:     body.name,
      phone:    body.phone,
      doc:      body.doc,
    })
  }

  @Post('by-slug/:slug/login')
  @Public()
  async login(
    @Param('slug') slug: string,
    @Body() body: { email?: string; password?: string },
  ) {
    const orgId = await this.resolveOrg(slug)
    if (!orgId) throw new BadRequestException('Loja não encontrada')
    if (!body?.email || !body?.password) throw new BadRequestException('email e password obrigatórios')
    return this.svc.login(orgId, { email: body.email, password: body.password })
  }

  @Get('me')
  @Public()
  async me(@Headers('authorization') auth?: string) {
    const token = extractToken(auth)
    return this.svc.getCurrentByToken(token)
  }

  @Patch('me')
  @Public()
  async updateMe(
    @Headers('authorization') auth: string | undefined,
    @Body() body: { name?: string; phone?: string | null; doc?: string | null; addresses?: Address[]; accepts_marketing?: boolean },
  ) {
    const token = extractToken(auth)
    const cur = await this.svc.getCurrentByToken(token)
    return this.svc.update(cur.id, body)
  }

  @Get('me/orders')
  @Public()
  async myOrders(@Headers('authorization') auth?: string) {
    const token = extractToken(auth)
    const cur = await this.svc.getCurrentByToken(token)
    return this.svc.listOrders(cur.organization_id, cur.id, cur.email)
  }

  private async resolveOrg(slug: string): Promise<string | null> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    return (data?.organization_id as string) ?? null
  }
}

function extractToken(auth?: string): string {
  if (!auth || !auth.startsWith('Bearer ')) throw new UnauthorizedException('Bearer token obrigatório')
  return auth.slice(7).trim()
}
