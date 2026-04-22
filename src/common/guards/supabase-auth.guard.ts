import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { supabaseAdmin } from '../supabase'

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest()
    const auth = req.headers['authorization'] as string | undefined

    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('Missing token')

    const token = auth.slice(7)
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) throw new UnauthorizedException('Invalid token')

    // Fetch org_id for the user
    const { data: member } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .maybeSingle()

    req.reqUser = { id: user.id, orgId: member?.organization_id ?? null }
    return true
  }
}
