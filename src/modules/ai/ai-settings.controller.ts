import {
  Controller, Get, Put, Delete, Body, Param, Query,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { AiSettingsService, UpsertFeatureSettingDto } from './ai-settings.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('ai')
@UseGuards(SupabaseAuthGuard)
export class AiSettingsController {
  constructor(private readonly svc: AiSettingsService) {}

  @Get('settings')
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listForOrg(u.orgId)
  }

  @Put('settings/:featureKey')
  upsert(
    @ReqUser() u: ReqUserPayload,
    @Param('featureKey') featureKey: string,
    @Body() body: UpsertFeatureSettingDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.upsert(u.orgId, featureKey, body)
  }

  @Delete('settings/:featureKey')
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
