import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'

/** Guard que valida o header `x-admin-secret` contra a env `ADMIN_SECRET`.
 * Usado por endpoints chamados por crons externos (GitHub Action, cron OS,
 * Claude scheduled agent) que NÃO têm session token Supabase. Se a env
 * não estiver setada, bloqueia tudo — fail-secure. */
@Injectable()
export class AdminSecretGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.ADMIN_SECRET
    if (!expected) throw new UnauthorizedException('ADMIN_SECRET não configurado no servidor')

    const req = ctx.switchToHttp().getRequest<Request>()
    const provided = (req.headers['x-admin-secret'] as string | undefined) ?? ''
    if (provided !== expected) throw new UnauthorizedException('x-admin-secret inválido ou ausente')

    return true
  }
}
