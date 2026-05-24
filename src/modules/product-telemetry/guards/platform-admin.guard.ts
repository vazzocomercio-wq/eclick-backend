import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

// Espelha PLATFORM_ADMIN_EMAILS do frontend (lib/modules.ts). Override via env.
const ALLOW = (process.env.PLATFORM_ADMIN_EMAILS ?? 'vazzocomercio@gmail.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

/**
 * Restringe ao founder / equipe e-Click. Roda DEPOIS do SupabaseAuthGuard
 * global (que já setou req.reqUser). O dashboard /insights é cross-org, então
 * só platform-admin pode ver — gating por allowlist de email.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest()
    const userId = req.reqUser?.id as string | undefined
    if (!userId) throw new ForbiddenException('Não autenticado')

    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId)
    const email = data?.user?.email?.toLowerCase()
    if (error || !email || !ALLOW.includes(email)) {
      throw new ForbiddenException('Acesso restrito à equipe e-Click')
    }
    return true
  }
}
