import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { UserPreferencesService, PREF_DEFAULTS } from './user-preferences.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('user-preferences')
@UseGuards(SupabaseAuthGuard)
export class UserPreferencesController {
  constructor(private readonly svc: UserPreferencesService) {}

  @Get()
  async getAll(@ReqUser() u: ReqUserPayload) {
    try {
      return await this.svc.getAll(u.id)
    } catch {
      return PREF_DEFAULTS
    }
  }

  @Patch()
  async patch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { key: string; value: string },
  ) {
    if (!body?.key) return { ok: false, message: 'key obrigatório' }
    try {
      return await this.svc.upsert(u.id, body.key, String(body.value ?? ''))
    } catch (e: unknown) {
      const err = e as { message?: string }
      return { ok: false, message: err?.message ?? 'erro' }
    }
  }
}
