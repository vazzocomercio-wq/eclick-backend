import {
  Controller, Get, Query, Res, UseGuards, BadRequestException,
} from '@nestjs/common'
import type { Response } from 'express'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CanvaOauthService } from './canva-oauth.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('canva/oauth')
export class CanvaOauthController {
  constructor(private readonly svc: CanvaOauthService) {}

  /** GET /canva/oauth/start — autenticado. Retorna { authorize_url } pra
   * frontend fazer window.location.href = url. NÃO faz redirect direto
   * porque o JWT vai num header (Bearer) que window.location não preserva. */
  @Get('start')
  @UseGuards(SupabaseAuthGuard)
  start(
    @ReqUser() u: ReqUserPayload,
    @Query('redirect_to') redirectTo?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.buildAuthorizeUrl(u.orgId, u.id, redirectTo)
  }

  /** GET /canva/oauth/callback?code=&state= — Public (Canva chama).
   * state contém o token CSRF que mapeia pra orgId+code_verifier no DB. */
  @Get('callback')
  @Public()
  async callback(
    @Query('code')  code:  string,
    @Query('state') state: string,
    @Res() res:     Response,
  ) {
    if (!code)  throw new BadRequestException('code ausente')
    if (!state) throw new BadRequestException('state ausente')

    const result = await this.svc.exchangeCode(code, state)

    // Redireciona pra frontend. Default vai pra /configuracoes/ia onde o
    // user vê o status "Conectado". Se redirect_to estava no oauth_state,
    // honra isso (útil pra "voltar pro wizard de campanhas").
    const frontendBase = process.env.FRONTEND_URL ?? 'https://app.eclick.com.br'
    const target = result.redirect_to
      ? `${frontendBase}${result.redirect_to.startsWith('/') ? '' : '/'}${result.redirect_to}`
      : `${frontendBase}/dashboard/configuracoes/ia?canva=connected`
    return res.redirect(target)
  }

  /** GET /canva/oauth/status — usado pelo frontend pra desenhar o botão. */
  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  async status(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStatus(u.orgId)
  }
}
