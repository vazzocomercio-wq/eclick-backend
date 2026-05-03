import {
  Controller, Get, Post, Patch, Delete, Param, Body, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { ChannelsService } from './channels.service'
import type { CreateChannelDto } from './dto/create-channel.dto'
import type { UpdateChannelDto } from './dto/update-channel.dto'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('channels')
@UseGuards(SupabaseAuthGuard)
export class ChannelsController {
  constructor(private readonly svc: ChannelsService) {}

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
  create(@ReqUser() u: ReqUserPayload, @Body() body: CreateChannelDto) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(u.orgId, body)
  }

  @Patch(':id')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateChannelDto,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(u.orgId, id, body)
  }

  @Delete(':id')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }
}
