import { Controller, Post, Body, Req, BadRequestException } from '@nestjs/common'
import { Request } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { StorefrontEventsService } from './storefront-events.service'
import { hashIp } from '../storefront-leads/storefront-leads.service'

/**
 * Endpoints publicos chamados pela vitrine pra disparar eventos
 * (cart_abandoned, etc). Sem auth — sao chamadas client-side.
 */
@Controller('storefront/events')
export class StorefrontEventsController {
  constructor(private readonly svc: StorefrontEventsService) {}

  /**
   * POST /storefront/events/cart-abandoned
   * Body: { slug, customer_phone?, customer_email?, customer_name?, items, subtotal, cart_id? }
   * Encaminha pro Active disparar automacao de recuperacao.
   */
  @Post('cart-abandoned')
  @Public()
  cartAbandoned(@Body() body: {
    slug?:           string
    customer_phone?: string
    customer_email?: string
    customer_name?:  string
    items?:          Array<{ productId: string; name: string; price: number; qty: number }>
    subtotal?:       number
    cart_id?:        string
  }) {
    if (!body?.slug)  throw new BadRequestException('slug obrigatório')
    if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException('items obrigatório')
    }
    return this.svc.triggerCartAbandoned({
      slug:           body.slug,
      customer_phone: body.customer_phone,
      customer_email: body.customer_email,
      customer_name:  body.customer_name,
      items:          body.items,
      subtotal:       body.subtotal ?? 0,
      cart_id:        body.cart_id,
    })
  }

  /**
   * POST /storefront/events/track  (beacon público, fire-and-forget)
   * Body: { slug, sessionId, events: [{ type, productId?, value?, source?, meta? }] }
   * Nunca retorna erro — beacon não pode quebrar a vitrine.
   */
  @Post('track')
  @Public()
  track(
    @Req() req: Request,
    @Body() body: {
      slug?:      string
      sessionId?: string
      events?:    Array<{ type: string; productId?: string; value?: number; source?: string; meta?: Record<string, unknown> }>
    },
  ) {
    const ip = String(
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      ?? req.socket?.remoteAddress ?? '',
    )
    return this.svc.track({
      slug:      body?.slug ?? '',
      sessionId: body?.sessionId ?? '',
      events:    Array.isArray(body?.events) ? body.events : [],
      ipHash:    ip ? hashIp(ip) : null,
    })
  }
}
