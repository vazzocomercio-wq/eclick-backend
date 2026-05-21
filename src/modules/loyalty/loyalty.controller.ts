import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { LoyaltyService, type LoyaltySettings, type LoyaltyTier } from './loyalty.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../common/supabase'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('loyalty')
@UseGuards(SupabaseAuthGuard)
export class LoyaltyController {
  constructor(private readonly svc: LoyaltyService) {}

  @Get('settings')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(u.orgId)
  }

  @Patch('settings')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: Partial<LoyaltySettings>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(u.orgId, body)
  }

  @Get('tiers')
  listTiers(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listTiers(u.orgId)
  }

  @Post('tiers')
  createTier(@ReqUser() u: ReqUserPayload, @Body() body: Partial<LoyaltyTier>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createTier(u.orgId, body)
  }

  @Patch('tiers/:id')
  updateTier(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<LoyaltyTier>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateTier(u.orgId, id, body)
  }

  @Delete('tiers/:id')
  deleteTier(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteTier(u.orgId, id)
  }

  /** POST /loyalty/seed-defaults — cria 3 níveis padrão (Bronze/Prata/Ouro). */
  @Post('seed-defaults')
  seedDefaults(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.seedDefaultTiers(u.orgId)
  }

  @Get('stats')
  getStats(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStats(u.orgId)
  }

  @Get('customer/:email')
  getCustomer(@ReqUser() u: ReqUserPayload, @Param('email') email: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getCustomerLoyalty(u.orgId, email)
  }
}

@Controller('public/loyalty')
export class LoyaltyPublicController {
  constructor(private readonly svc: LoyaltyService) {}

  /** GET /public/loyalty/by-slug/:slug/tiers — lista pra vitrine mostrar
   *  programa de fidelidade em página de info. */
  @Get('by-slug/:slug/tiers')
  @Public()
  async tiersBySlug(@Param('slug') slug: string) {
    const orgId = await this.resolveOrg(slug)
    if (!orgId) return { enabled: false, tiers: [] }
    const settings = await this.svc.getSettings(orgId)
    if (!settings.enabled) return { enabled: false, tiers: [] }
    const tiers = (await this.svc.listTiers(orgId)).filter(t => t.active)
    return { enabled: true, settings, tiers }
  }

  /** GET /public/loyalty/by-slug/:slug/customer?email= — cliente consulta tier. */
  @Get('by-slug/:slug/customer')
  @Public()
  async customerBySlug(@Param('slug') slug: string, @Query('email') email?: string) {
    if (!email) throw new BadRequestException('email obrigatório')
    const orgId = await this.resolveOrg(slug)
    if (!orgId) return null
    const settings = await this.svc.getSettings(orgId)
    if (!settings.enabled) return { enabled: false }
    const data = await this.svc.getCustomerLoyalty(orgId, email)
    return { enabled: true, ...data }
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
