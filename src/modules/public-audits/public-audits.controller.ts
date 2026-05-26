import { Controller, Post, Get, Body, Param, Req } from '@nestjs/common'
import type { Request } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { PublicAuditsService } from './public-audits.service'

/**
 * Endpoints PÚBLICOS (sem auth) da landing "Auditoria GEO Grátis".
 *
 *   POST /public/audits/start  → cria a auditoria + lead no Active, devolve { audit_id, polling_url }
 *   GET  /public/audits/:id    → status sanitizado (sem PII) pro front pollar
 *
 * Sem @UseGuards (rota anônima). @Public() é defensivo caso um guard global
 * seja adicionado no futuro.
 */
@Controller('public/audits')
export class PublicAuditsController {
  constructor(private readonly svc: PublicAuditsService) {}

  @Post('start')
  @Public()
  async start(
    @Body() body: {
      name?: string; email?: string; whatsapp?: string; url?: string
      category?: string; lgpd?: boolean; honeypot?: string
      utm?: Record<string, string>
    },
    @Req() req: Request,
  ) {
    return this.svc.start(
      {
        name:     body.name ?? '',
        email:    body.email ?? '',
        whatsapp: body.whatsapp ?? '',
        url:      body.url ?? '',
        category: body.category,
        lgpd:     body.lgpd === true,
        honeypot: body.honeypot,
        utm:      body.utm,
      },
      clientIp(req),
      req.headers['user-agent'],
    )
  }

  @Post('unsubscribe')
  @Public()
  async unsubscribe(@Body() body: { audit_id?: string }) {
    return this.svc.unsubscribe(body.audit_id ?? '')
  }

  @Get(':id')
  @Public()
  async status(@Param('id') id: string) {
    return this.svc.getStatus(id)
  }
}

/** IP do visitante atrás do proxy do Railway (x-forwarded-for tem prioridade). */
function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim()
  if (Array.isArray(xff) && xff.length > 0) return xff[0].trim()
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown'
}
