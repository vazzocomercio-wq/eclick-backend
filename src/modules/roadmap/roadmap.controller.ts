import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Param, Patch, Post, UseGuards,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RoadmapService, RoadmapStatus } from './roadmap.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('roadmap')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class RoadmapController {
  constructor(private readonly svc: RoadmapService) {}

  @Get()
  @RequirePermission('settings.view')
  list(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(user.orgId)
  }

  @Patch('phases/:id')
  @RequirePermission('settings.update')
  updatePhase(
    @ReqUser() user: ReqUserPayload,
    @Param('id')  id: string,
    @Body() body: { status?: RoadmapStatus; pct?: number; label?: string; sub?: string | null },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updatePhase(user.orgId, id, body)
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('settings.update')
  createItem(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { phase_id: string; label: string; status?: RoadmapStatus; priority?: number; notes?: string | null },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createItem(user.orgId, body)
  }

  @Patch('items/:id')
  @RequirePermission('settings.update')
  updateItem(
    @ReqUser() user: ReqUserPayload,
    @Param('id')  id: string,
    @Body() body: { status?: RoadmapStatus; label?: string; priority?: number; notes?: string | null },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.updateItem(user.orgId, id, body)
  }

  @Delete('items/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('settings.update')
  deleteItem(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteItem(user.orgId, id)
  }
}
