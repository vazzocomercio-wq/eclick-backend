import {
  Controller, Get, Post, Put, Body, Param, Query, Req, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { Request } from 'express'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { Public } from '../../common/decorators/public.decorator'
import { CartRecoveryService, hashIp, type CartItem } from './cart-recovery.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Lojista: gerencia recoveries + settings.
 *
 *   GET    /cart-recovery               ?status=&limit=&offset=
 *   GET    /cart-recovery/settings
 *   PUT    /cart-recovery/settings
 *   POST   /cart-recovery/:id/send-now  (envia ad-hoc)
 *   POST   /cart-recovery/:id/dismiss
 *   POST   /cart-recovery/run-tick      (testing — dispara cron manualmente)
 */
@Controller('cart-recovery')
@UseGuards(SupabaseAuthGuard)
export class CartRecoveryController {
  constructor(private readonly svc: CartRecoveryService) {}

  @Get()
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listForOwner(u.orgId, {
      status,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Get('settings')
  getSettings(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getSettings(u.orgId)
  }

  @Put('settings')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: {
    enabled?:              boolean
    minutes_after?:        number
    ttl_hours?:            number
    message_template?:     string
    coupon_enabled?:       boolean
    coupon_discount_pct?:  number
    coupon_expires_hours?: number
  }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateSettings(u.orgId, body)
  }

  @Post(':id/send-now')
  sendNow(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.sendNow(u.orgId, id)
  }

  @Post(':id/dismiss')
  dismiss(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.dismiss(u.orgId, id)
  }

  @Post('run-tick')
  runTick(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.runRecoveryTick()
  }
}

/** Endpoint público: vitrine pinga aqui ao mexer no carrinho.
 *
 *   POST /public/store/by-slug/:slug/cart/track
 *     { customer_id?, phone?, email?, name?, items, subtotal }
 */
@Controller('public/store/by-slug')
export class CartRecoveryPublicController {
  constructor(private readonly svc: CartRecoveryService) {}

  @Post(':slug/cart/track')
  @Public()
  async track(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Body() body: {
      customer_id?: string | null
      phone?:       string | null
      email?:       string | null
      name?:        string | null
      items?:       CartItem[]
      subtotal?:    number
    },
  ) {
    const items = Array.isArray(body?.items) ? body.items : []
    const subtotal = typeof body?.subtotal === 'number' ? body.subtotal : 0
    const ip = String(
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      ?? req.socket?.remoteAddress ?? '',
    )
    const ipHash = ip ? hashIp(ip) : null

    return this.svc.trackCart({
      slug,
      customer_id: body.customer_id,
      phone:       body.phone,
      email:       body.email,
      name:        body.name,
      items,
      subtotal,
      ipHash,
    })
  }
}
