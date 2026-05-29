import {
  Controller, Post, Body, Req, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { Request } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { AffiliateRegistrationService, RegisterInput } from './affiliate-registration.service'

/** F18 F4.3 — Endpoints PÚBLICOS de self-signup do afiliado.
 *
 *  /sou-afiliado-shopee (frontend público) → POST aqui. Sem auth: é
 *  cadastro inbound. O consent_given=true é o gate LGPD. */
@Controller('shopee-affiliate/public')
export class AffiliateRegistrationController {
  constructor(private readonly svc: AffiliateRegistrationService) {}

  /** POST /shopee-affiliate/public/register — self-signup com consent. */
  @Post('register')
  @Public()
  @HttpCode(HttpStatus.OK)
  register(
    @Req() req: Request,
    @Body() body: RegisterInput,
  ) {
    if (!body) throw new BadRequestException('body vazio')
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket?.remoteAddress
      ?? null
    return this.svc.register({ ...body, ip })
  }

  /** POST /shopee-affiliate/public/opt-out — revogação (LGPD). */
  @Post('opt-out')
  @Public()
  @HttpCode(HttpStatus.OK)
  async optOut(@Body() body: { id: string; reason?: string }) {
    if (!body?.id) throw new BadRequestException('id obrigatório')
    await this.svc.optOut(body.id, body.reason)
    return { ok: true }
  }
}
