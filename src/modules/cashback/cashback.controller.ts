import {
  Controller, Get, Patch, Post, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { CashbackService, type CashbackSettings } from './cashback.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../common/supabase'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Admin (autenticado):
 *   GET   /cashback/settings
 *   PATCH /cashback/settings
 *   GET   /cashback/stats
 *   GET   /cashback/balance/:email
 *   GET   /cashback/movements/:email
 *   POST  /cashback/adjust  (ajuste manual: +N ou -N)
 *
 * Público (vitrine):
 *   GET   /public/cashback/by-slug/:slug/balance?email=
 *   POST  /public/cashback/by-slug/:slug/preview-redemption (email, orderTotalCents)
 */

@Controller('cashback')
@UseGuards(SupabaseAuthGuard)
export class CashbackController {
  constructor(private readonly svc: CashbackService) {}

  @Get('settings')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(u.orgId)
  }

  @Patch('settings')
  updateSettings(
    @ReqUser() u: ReqUserPayload,
    @Body() body: Partial<CashbackSettings>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(u.orgId, body)
  }

  @Get('stats')
  getStats(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStats(u.orgId)
  }

  @Get('balance/:email')
  getBalance(@ReqUser() u: ReqUserPayload, @Param('email') email: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getBalance(u.orgId, email)
  }

  @Get('movements/:email')
  listMovements(
    @ReqUser() u: ReqUserPayload,
    @Param('email') email: string,
    @Query('limit')  limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listMovements(u.orgId, email, {
      limit:  limit  ? parseInt(limit,  10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  }

  /** Ajuste manual de saldo — entrada ou saída. Útil pra suporte/correção. */
  @Post('adjust')
  adjust(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { email: string; amountCents: number; reason?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.email || typeof body.amountCents !== 'number') {
      throw new BadRequestException('email + amountCents obrigatórios')
    }
    const reason = body.reason ?? 'Ajuste manual'
    if (body.amountCents > 0) {
      return this.svc.credit({
        orgId:       u.orgId,
        email:       body.email,
        amountCents: body.amountCents,
        reason,
        sourceKind:  'admin_adjust',
        sourceId:    `${u.id}-${Date.now()}`,
      })
    } else {
      return this.svc.redeem({
        orgId:       u.orgId,
        email:       body.email,
        amountCents: Math.abs(body.amountCents),
        reason,
        sourceKind:  'admin_adjust',
        sourceId:    `${u.id}-${Date.now()}`,
      })
    }
  }
}

@Controller('public/cashback')
export class CashbackPublicController {
  constructor(private readonly svc: CashbackService) {}

  /** Vitrine: cliente informa email → vê saldo. Resolve org via slug. */
  @Get('by-slug/:slug/balance')
  @Public()
  async balanceBySlug(
    @Param('slug') slug: string,
    @Query('email') email?: string,
  ) {
    if (!email) throw new BadRequestException('email obrigatório')
    const orgId = await this.resolveOrg(slug)
    if (!orgId) return { balance: 0, enabled: false }
    const settings = await this.svc.getSettings(orgId)
    if (!settings.enabled) return { balance: 0, enabled: false }
    const balance = await this.svc.getBalance(orgId, email)
    return {
      balance:                 balance?.balance_cents ?? 0,
      enabled:                 true,
      settings: {
        minBalanceToUseCents:     settings.minBalanceToUseCents,
        maxRedemptionPctPerOrder: settings.maxRedemptionPctPerOrder,
        earnPct:                  settings.earnPct,
      },
    }
  }

  @Post('by-slug/:slug/preview-redemption')
  @Public()
  async previewRedemption(
    @Param('slug') slug: string,
    @Body() body: { email: string; orderTotalCents: number },
  ) {
    if (!body?.email || typeof body?.orderTotalCents !== 'number') {
      throw new BadRequestException('email + orderTotalCents obrigatórios')
    }
    const orgId = await this.resolveOrg(slug)
    if (!orgId) return { maxRedeemableCents: 0, balance: 0, enabled: false }
    return this.svc.previewRedemption(orgId, body.email, body.orderTotalCents)
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
