import {
  Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { BonusService, type BonusRule, type CartLineForEval } from './bonus.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { RateLimit, RateLimitGuard } from '../../common/guards/rate-limit.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../common/supabase'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('bonus-rules')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class BonusController {
  constructor(private readonly svc: BonusService) {}

  @Get()
  @RequirePermission('store.view')
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId)
  }

  @Post()
  @RequirePermission('store.update')
  create(@ReqUser() u: ReqUserPayload, @Body() body: Partial<BonusRule>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, body)
  }

  @Patch(':id')
  @RequirePermission('store.update')
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<BonusRule>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete(':id')
  @RequirePermission('store.update')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }
}

@Controller('public/bonus')
export class BonusPublicController {
  constructor(private readonly svc: BonusService) {}

  /** Vitrine consulta brindes aplicáveis a um carrinho. Resolve org por slug. */
  @Post('by-slug/:slug/preview')
  @Public()
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 30, windowMs: 60_000, keyPrefix: 'sf-bonus-preview' })
  async preview(
    @Param('slug') slug: string,
    @Body() body: { lines: CartLineForEval[] },
  ) {
    if (!Array.isArray(body?.lines)) throw new BadRequestException('lines[] obrigatório')
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!data) return { applied: [] }
    return { applied: await this.svc.evaluateCart(data.organization_id as string, body.lines) }
  }

  /** Vitrine consulta regras ativas — usado pra badge BOGO no card do
   *  produto (mostrar "LEVE 2 PAGUE 1" quando produto X tem regra ativa). */
  @Get('by-slug/:slug/active-rules')
  @Public()
  async activeRules(@Param('slug') slug: string) {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!data) return { rules: [] }
    const all = await this.svc.list(data.organization_id as string)
    const nowMs = Date.now()
    const rules = all.filter(r => {
      if (!r.active) return false
      if (r.starts_at && Date.parse(r.starts_at) > nowMs) return false
      if (r.ends_at   && Date.parse(r.ends_at)   < nowMs) return false
      return true
    })
    return { rules }
  }
}
