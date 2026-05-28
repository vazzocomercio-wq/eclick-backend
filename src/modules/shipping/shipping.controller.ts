import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { Public } from '../../common/decorators/public.decorator'
import { supabaseAdmin } from '../../common/supabase'
import { ShippingService } from './shipping.service'
import type { ShippingRule } from './shipping.types'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller()
export class ShippingController {
  constructor(private readonly svc: ShippingService) {}

  // ─ Admin (com auth) ──────────────────────────────────────────

  @Get('shipping-rules')
  @UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
  @RequirePermission('store.view')
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId)
  }

  @Post('shipping-rules')
  @UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
  @RequirePermission('store.update')
  create(@ReqUser() u: ReqUserPayload, @Body() body: Partial<ShippingRule>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, body)
  }

  @Put('shipping-rules/:id')
  @UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
  @RequirePermission('store.update')
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Partial<ShippingRule>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete('shipping-rules/:id')
  @UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
  @RequirePermission('store.update')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }

  // ─ Public: calcula opcoes de frete pra um CEP ────────────────

  /**
   * GET /shipping/calculate?slug=<slug>&cep=<cep>&subtotal_cents=<n>&weight_kg=<n>
   * Retorna lista de opcoes de frete elegiveis (a aplicar no checkout).
   */
  @Get('shipping/calculate')
  @Public()
  async calculate(
    @Query('slug') slug: string,
    @Query('cep') cep: string,
    @Query('subtotal_cents') subtotal: string,
    @Query('weight_kg') weight?: string,
  ) {
    if (!slug || !cep) throw new BadRequestException('slug e cep obrigatórios')
    const { data: store } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!store) throw new BadRequestException('Loja não encontrada.')
    return this.svc.calculate((store as { organization_id: string }).organization_id, {
      cep,
      subtotalCents: Math.max(0, parseInt(subtotal ?? '0', 10) || 0),
      weightKg:      weight ? parseFloat(weight) : undefined,
    })
  }
}
