import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { PermissionService } from './permission.service'
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator'

/**
 * F17-B · Guard que enforça `@RequirePermission(...keys)`. Depende de
 * `SupabaseAuthGuard` ter rodado antes (precisa de `req.reqUser` com
 * `{ id, orgId }`).
 *
 * Múltiplas keys exigem TODAS (AND). Se faltar alguma, 403 com a lista
 * das que faltaram (ajuda debug; não revela permissions de outros users).
 */
@Injectable()
export class RequirePermissionGuard implements CanActivate {
  private readonly logger = new Logger(RequirePermissionGuard.name)

  constructor(
    private readonly reflector: Reflector,
    private readonly perms:     PermissionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRE_PERMISSION_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    // Sem decorator = sem enforcement (Guard inerte). Liberar.
    if (!required || required.length === 0) return true

    const req = ctx.switchToHttp().getRequest()
    const user = req.reqUser as { id?: string; orgId?: string } | undefined
    if (!user?.id || !user?.orgId) {
      // SupabaseAuthGuard deveria ter setado isto. Se não setou, é misconfig.
      throw new ForbiddenException('Sessão sem usuário/organização (SupabaseAuthGuard não rodou?).')
    }

    const have = await this.perms.getUserPermissions(user.id, user.orgId)
    const missing = required.filter(k => !have.has(k))
    if (missing.length > 0) {
      this.logger.warn(`[rbac.guard] DENY user=${user.id} org=${user.orgId} missing=${missing.join(',')}`)
      throw new ForbiddenException(`Sem permissão: ${missing.join(', ')}`)
    }
    return true
  }
}
