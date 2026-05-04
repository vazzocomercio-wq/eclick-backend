import {
  Controller, Get, Post, Patch, Delete, Param, Body, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { AlertManagersService } from './alert-managers.service'
import type { CreateManagerDto } from './dto/create-manager.dto'
import type { UpdateManagerDto } from './dto/update-manager.dto'
import type { ConfirmPhoneDto } from './dto/confirm-phone.dto'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('alert-managers')
@UseGuards(SupabaseAuthGuard)
export class AlertManagersController {
  constructor(private readonly svc: AlertManagersService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId)
  }

  @Get(':id')
  findOne(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.findOne(u.orgId, id)
  }

  @Post()
  create(@ReqUser() u: ReqUserPayload, @Body() body: CreateManagerDto) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, body)
  }

  @Patch(':id')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateManagerDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete(':id')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }

  @Post(':id/verify-phone')
  verifyPhone(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.sendVerificationCode(u.orgId, id)
  }

  @Post(':id/confirm-phone')
  confirmPhone(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: ConfirmPhoneDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.confirmPhone(u.orgId, id, body?.code)
  }
}
