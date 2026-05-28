import {
  Controller, Post, Get, Patch, Body, Query, Param, Req, Headers, BadRequestException,
  HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common'
import { Public } from '../../common/decorators/public.decorator'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { PaymentsService } from './payments.service'
import type { CheckoutCustomer, CheckoutItem, Gateway } from './types'
import type { Request } from 'express'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Loja Propria — Frente C: endpoints public-facing do checkout.
 *
 *   POST /storefront/checkout
 *       { slug, items[], customer, gateway: 'mercadopago' | 'stripe' }
 *       Cria pedido + cria preference no gateway + retorna initPoint.
 *
 *   GET  /storefront/order/:id
 *       Detalhe publico (status + items + total). Usado pelas paginas
 *       /pedido/[id]/sucesso /falha /pendente.
 *
 *   POST /storefront/webhooks/mp     ?topic=payment&id=N
 *   POST /storefront/webhooks/stripe (raw body + Stripe-Signature header)
 */
@Controller('storefront')
export class PaymentsController {
  constructor(private readonly svc: PaymentsService) {}

  @Post('checkout')
  @Public()
  async checkout(@Body() body: {
    slug?:           string
    items?:          CheckoutItem[]
    customer?:       CheckoutCustomer
    gateway?:        Gateway
    cashbackToUse?:  number   // centavos — opt-in
    customerId?:     string   // FK opcional (cliente logado)
    affiliateCode?:  string   // code do afiliado vindo do cookie ?ref=
    couponCode?:     string   // cupom aplicado no checkout (validado server-side)
  }) {
    if (!body?.slug)     throw new BadRequestException('slug obrigatório')
    if (!body?.items)    throw new BadRequestException('items obrigatório')
    if (!body?.customer) throw new BadRequestException('customer obrigatório')
    if (!body?.gateway)  throw new BadRequestException('gateway obrigatório')
    return this.svc.checkout({
      slug:           body.slug,
      items:          body.items,
      customer:       body.customer,
      gateway:        body.gateway,
      cashbackToUse:  typeof body.cashbackToUse === 'number' && body.cashbackToUse > 0
                        ? Math.floor(body.cashbackToUse)
                        : undefined,
      customerId:     body.customerId,
      affiliateCode:  body.affiliateCode,
      couponCode:     body.couponCode?.trim() || undefined,
    })
  }

  @Get('order/:id')
  @Public()
  async getOrder(@Param('id') id: string) {
    const order = await this.svc.getPublicOrder(id)
    if (!order) throw new BadRequestException('Pedido não encontrado.')
    return order
  }

  @Post('webhooks/mp')
  @Public()
  @HttpCode(HttpStatus.OK) // MP exige 200 pra parar de retry
  async mpWebhook(
    @Query() query: Record<string, string>,
    @Body()  body:  Record<string, unknown>,
  ) {
    // Mercado Pago envia o `id` via query OU via body.data.id (novo formato)
    const merged: Record<string, string> = {
      ...query,
      ...(body?.data && typeof body.data === 'object'
        ? Object.fromEntries(Object.entries(body.data as Record<string, unknown>).map(([k, v]) => [`data.${k}`, String(v)]))
        : {}),
      ...(body?.type ? { type: String(body.type) } : {}),
      ...(body?.action ? { action: String(body.action) } : {}),
    }
    await this.svc.handleMercadoPagoWebhook(merged)
    return { ok: true }
  }

  @Post('webhooks/stripe')
  @Public()
  @HttpCode(HttpStatus.OK)
  async stripeWebhook(
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) throw new BadRequestException('Stripe-Signature ausente')
    // Pra HMAC funcionar precisamos do body raw. main.ts ja faz parsing JSON
    // global; pra esta rota recuperamos o rawBody se foi anexado (NestJS +
    // express raw middleware) ou fazemos um JSON.stringify defensivo do body
    // ja parseado (funciona em testes; em prod prefira raw body middleware).
    type ReqWithRaw = Request & { rawBody?: Buffer | string }
    const r = req as ReqWithRaw
    const raw: string = typeof r.rawBody === 'string'
      ? r.rawBody
      : Buffer.isBuffer(r.rawBody)
        ? r.rawBody.toString('utf8')
        : JSON.stringify(req.body ?? {})
    await this.svc.handleStripeWebhook(raw, signature)
    return { ok: true }
  }
}

/**
 * Admin (autenticado): gerenciar pedidos da Loja Própria.
 *
 *   PATCH /storefront-orders/:id/shipping
 *       { shipping_status?, shipping_carrier?, tracking_code? }
 */
@Controller('storefront-orders')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class StorefrontOrdersAdminController {
  constructor(private readonly svc: PaymentsService) {}

  @Patch(':id/shipping')
  @RequirePermission('orders.update_status')
  updateShipping(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      shipping_status?:  'pending' | 'preparing' | 'shipped' | 'in_transit' | 'delivered' | 'returned' | 'lost'
      shipping_carrier?: string | null
      tracking_code?:    string | null
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateShipping(u.orgId, id, body)
  }
}
