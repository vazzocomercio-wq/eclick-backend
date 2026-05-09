import {
  Controller, Get, Post, Param, Body, Req, Res, Headers,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { DropshipService } from './dropship.service'

/**
 * Endpoints públicos do portal do parceiro — SEM SupabaseAuthGuard.
 * Token é o secret: 64 chars hex random (crypto.randomBytes(32).toString('hex')).
 *
 * URL pública: GET /portal/oc/:token
 *
 * Cada acesso registra IP + user_agent na sessão pra auditoria.
 * Token expira em 72h (PORTAL_TTL_HOURS no service).
 */
@Controller('portal/oc')
export class DropshipPortalController {
  constructor(private readonly svc: DropshipService) {}

  /** Visualizar OC sem login */
  @Get(':token')
  async viewOC(
    @Param('token') token: string,
    @Req() req: Request,
    @Headers('user-agent') userAgent?: string,
  ) {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket?.remoteAddress ??
      null
    return this.svc.viewOCByToken(token, ip, userAgent ?? null)
  }

  /** Aprovar OC */
  @Post(':token/approve')
  async approveOC(
    @Param('token') token: string,
    @Body() body: { approver_name: string; approver_email: string; notes?: string },
  ) {
    return this.svc.approveOCByToken(token, body)
  }

  /** Rejeitar OC */
  @Post(':token/reject')
  async rejectOC(
    @Param('token') token: string,
    @Body() body: { approver_name: string; approver_email: string; reason: string },
  ) {
    return this.svc.rejectOCByToken(token, body)
  }

  /** Download PDF da OC (público com token) */
  @Get(':token/pdf')
  async pdf(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const { buffer, ocNumber } = await this.svc.generateOCPdfByToken(token)
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${ocNumber}.pdf"`,
      'Cache-Control': 'no-store',
    })
    res.send(buffer)
  }
}
