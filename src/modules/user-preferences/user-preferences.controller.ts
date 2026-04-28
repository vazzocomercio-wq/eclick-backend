import { Controller, Get, Patch, Post, Body, Query, Req, UseGuards } from '@nestjs/common'
import type { Request } from 'express'
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

  // POST /user-preferences/audit-reveal — log LGPD de cada reveal de PII
  // disparado pelo <MaskedField>. Fire-and-forget no frontend, retorna 200
  // mesmo em falha pra não bloquear UI.
  @Post('audit-reveal')
  async auditReveal(
    @ReqUser() u: ReqUserPayload,
    @Req() req: Request,
    @Body() body: { field?: string; customer_id?: string | null },
  ) {
    const field = (body?.field ?? '') as 'cpf' | 'cnpj' | 'phone' | 'email'
    if (!['cpf','cnpj','phone','email'].includes(field)) return { ok: true }
    return this.svc.logReveal({
      userId:     u.id,
      field,
      customerId: body?.customer_id ?? null,
      ip:         (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip ?? null,
      userAgent:  req.headers['user-agent'] ?? null,
    })
  }

  // GET /user-preferences/audit-reveal?limit=50 — alimenta o card
  // "Auditoria" em /configuracoes/preferencias.
  @Get('audit-reveal')
  async listReveals(
    @ReqUser() u: ReqUserPayload,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listRecentReveals(u.id, limit ? Number(limit) : 50)
  }
}
