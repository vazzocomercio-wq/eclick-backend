import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CouponsService } from './coupons.service'
import { Public } from '../../common/decorators/public.decorator'
import { supabaseAdmin } from '../../common/supabase'
import type { CouponType } from './coupons.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Cupons — admin endpoints (com auth) + endpoint publico de apply
 * usado pelo carrinho da loja.
 */
@Controller('coupons')
export class CouponsController {
  constructor(private readonly svc: CouponsService) {}

  // ─ Admin (com auth) ─────────────────────────────────────────

  @Get()
  @UseGuards(SupabaseAuthGuard)
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId)
  }

  @Post()
  @UseGuards(SupabaseAuthGuard)
  create(@ReqUser() u: ReqUserPayload, @Body() body: {
    code?: string; type?: CouponType; value?: number;
    min_order_cents?: number; usage_limit?: number | null;
    expires_at?: string | null; description?: string | null; active?: boolean
  }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.code || !body?.type || typeof body.value !== 'number') {
      throw new BadRequestException('code, type e value obrigatórios')
    }
    return this.svc.create(u.orgId, {
      code: body.code, type: body.type, value: body.value,
      min_order_cents: body.min_order_cents,
      usage_limit:     body.usage_limit,
      expires_at:      body.expires_at,
      description:     body.description,
      active:          body.active,
    })
  }

  @Put(':id')
  @UseGuards(SupabaseAuthGuard)
  update(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete(':id')
  @UseGuards(SupabaseAuthGuard)
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }

  // ─ Public — apply no carrinho ────────────────────────────────

  /**
   * Endpoint publico — recebe slug da loja + code + subtotal e retorna
   * desconto calculado. NAO incrementa used_count (so o pagamento faz isso).
   *
   * GET /coupons/apply?slug=<slug>&code=<code>&subtotal_cents=<n>
   */
  @Get('apply')
  @Public()
  async apply(
    @Query('slug') slug: string,
    @Query('code') code: string,
    @Query('subtotal_cents') subtotal: string,
  ) {
    if (!slug || !code) throw new BadRequestException('slug e code obrigatórios')
    const subtotalCents = Math.max(0, parseInt(subtotal ?? '0', 10) || 0)
    // Resolve org pelo slug (a loja precisa estar active)
    const { data: store } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!store) throw new BadRequestException('Loja não encontrada.')
    return this.svc.apply((store as { organization_id: string }).organization_id, code, subtotalCents)
  }
}
