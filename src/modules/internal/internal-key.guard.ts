import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import type { Request } from 'express'

/**
 * Guard que valida header `X-Internal-Key` contra `INTERNAL_API_KEY` do env.
 * Usado por endpoints `/internal/*` chamados pelo worker (sem JWT do user).
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_KEY
    if (!expected) {
      throw new UnauthorizedException('INTERNAL_API_KEY não configurada no servidor')
    }
    const req = context.switchToHttp().getRequest<Request>()
    const header = req.headers['x-internal-key']
    const provided = Array.isArray(header) ? header[0] : header
    if (provided !== expected) {
      throw new UnauthorizedException('X-Internal-Key inválido')
    }
    return true
  }
}
