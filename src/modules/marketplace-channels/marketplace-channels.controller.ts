import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { MarketplaceChannelsService, UpdateMarketplaceChannelDto } from './marketplace-channels.service'

@Controller('marketplace-channels')
@UseGuards(SupabaseAuthGuard)
export class MarketplaceChannelsController {
  constructor(private readonly svc: MarketplaceChannelsService) {}

  @Get()
  list() {
    return this.svc.list()
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateMarketplaceChannelDto) {
    return this.svc.update(id, body)
  }
}
