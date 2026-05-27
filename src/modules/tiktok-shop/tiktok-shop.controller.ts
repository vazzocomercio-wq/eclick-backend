import {
  Controller,
  Get,
  Post,
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

  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  status(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStatus(u.orgId)
  }

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  disconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.disconnect(u.orgId)
  }
}
