import {
  Controller, Get, Put, Delete, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { AiSettingsService, UpsertFeatureSettingDto } from './ai-settings.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** AI-ABS-2: prefix mudou de 'ai' pra 'ai/feature-settings' pra evitar
 * collision com o controller legacy do atendente-ia que também é
 * @Controller('ai') @Get('settings'). Frontend foi atualizado pra bater
 * nos novos paths. Routes finais:
 *   GET    /ai/feature-settings              → list
 *   PUT    /ai/feature-settings/:featureKey  → upsert
 *   DELETE /ai/feature-settings/:featureKey  → reset
 *   GET    /ai/feature-settings/usage        → usage  */
@Controller('ai/feature-settings')
@UseGuards(SupabaseAuthGuard)
export class AiSettingsController {
  constructor(private readonly svc: AiSettingsService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listForOrg(u.orgId)
  }

  @Put(':featureKey')
  upsert(
    @ReqUser() u: ReqUserPayload,
    @Param('featureKey') featureKey: string,
    @Body() body: UpsertFeatureSettingDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.upsert(u.orgId, featureKey, body)
  }

  @Delete(':featureKey')
  reset(@ReqUser() u: ReqUserPayload, @Param('featureKey') featureKey: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.reset(u.orgId, featureKey)
  }

  @Get('usage')
  usage(@ReqUser() u: ReqUserPayload, @Query('days') days?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const n = Math.max(1, Math.min(90, Number(days ?? 30)))
    return this.svc.getUsage(u.orgId, n)
  }
}
