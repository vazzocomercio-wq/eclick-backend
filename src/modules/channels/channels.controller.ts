import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ChannelsService, UpdateChannelDto } from './channels.service'

@Controller('channels')
@UseGuards(SupabaseAuthGuard)
export class ChannelsController {
  constructor(private readonly svc: ChannelsService) {}

  @Get()
  list() {
    return this.svc.list()
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateChannelDto) {
    return this.svc.update(id, body)
  }
}
