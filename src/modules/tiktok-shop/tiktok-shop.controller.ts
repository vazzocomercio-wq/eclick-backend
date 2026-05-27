import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Query,
  Res,
  UseGuards,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { Response } from 'express'
import { TikTokShopService } from './tiktok-shop.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload {
  id: string
  orgId: string | null
}

/**
 * TikTok Shop (Personalizado) — Fase 1: OAuth.
 *
 *  GET  /tiktok-shop/oauth/auth-url   (auth)   → URL de autorização
 *  GET  /tiktok-shop/oauth/callback   (public) → TikTok Shop chama
 *  GET  /tiktok-shop/status           (auth)
 *  POST /tiktok-shop/disconnect       (auth)
 */
@Controller('tiktok-shop')
export class TikTokShopController {
  constructor(private readonly svc: TikTokShopService) {}

  /** Front chama, recebe a URL e faz window.location.href. */
  @Get('oauth/auth-url')
  @UseGuards(SupabaseAuthGuard)
  authUrl(
    @ReqUser() u: ReqUserPayload,
    @Query('redirect_to') redirectTo?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.buildAuthorizeUrl(u.orgId, u.id, redirectTo)
  }

  /** TikTok Shop redireciona pra cá com code+state. */
  @Get('oauth/callback')
  @Public()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendBase = process.env.FRONTEND_URL ?? 'https://eclick.app.br'
    const dest = '/dashboard/integracoes/tiktok-shop'
    if (!code || !state) {
      return res.redirect(`${frontendBase}${dest}?tiktok_shop=error&reason=missing_code_or_state`)
    }
    try {
      const r = await this.svc.exchangeCode(code, state)
      const base = r.redirect_to
        ? `${frontendBase}${r.redirect_to.startsWith('/') ? '' : '/'}${r.redirect_to}`
        : `${frontendBase}${dest}`
      const sep = base.includes('?') ? '&' : '?'
      return res.redirect(`${base}${sep}tiktok_shop=connected`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erro'
      return res.redirect(`${frontendBase}${dest}?tiktok_shop=error&reason=${encodeURIComponent(msg)}`)
    }
  }

  /** Webhook do TikTok Shop (tempo real). Público — autenticado por secret na
   *  URL (?key=) + assinatura HMAC. Responde 200 na hora e processa async
   *  (TikTok espera ack rápido). Faz sync ALVO do pedido/produto do evento. */
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  webhook(
    @Body() body: { type?: number; shop_id?: string | number; data?: Record<string, unknown> },
    @Query('key') key?: string,
    @Headers('authorization') auth?: string,
    @Headers('x-tts-signature') xsig?: string,
  ) {
    if (!this.svc.isWebhookSecretValid(key)) {
      throw new BadRequestException('webhook key inválida')
    }
    const sigOk = this.svc.verifyWebhookSignature(JSON.stringify(body ?? {}), xsig ?? auth)
    if (!sigOk && process.env.TIKTOK_SHOP_WEBHOOK_ENFORCE_SIG === 'true') {
      throw new BadRequestException('assinatura inválida')
    }
    // ack imediato + processa em background (não bloqueia a resposta)
    void this.svc.handleWebhook(body).catch(() => undefined)
    return { ok: true }
  }

  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  status(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStatus(u.orgId)
  }

  /** Lista as lojas autorizadas (chamada assinada) e guarda o shop_cipher. */
  @Get('shops')
  @UseGuards(SupabaseAuthGuard)
  shops(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getAuthorizedShops(u.orgId)
  }

  /** Importa pedidos do TikTok Shop pra tabela isolada (tiktok_shop_orders). */
  @Post('orders/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  importOrders(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.importOrders(u.orgId)
  }

  /** Lista os pedidos já importados. */
  @Get('orders')
  @UseGuards(SupabaseAuthGuard)
  orders(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listOrders(u.orgId)
  }

  /** Importa produtos do TikTok Shop pra tabela isolada (tiktok_shop_products). */
  @Post('products/import')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  importProducts(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.importProducts(u.orgId)
  }

  /** Lista os produtos já importados. */
  @Get('products')
  @UseGuards(SupabaseAuthGuard)
  products(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listProducts(u.orgId)
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  disconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.disconnect(u.orgId)
  }
}
