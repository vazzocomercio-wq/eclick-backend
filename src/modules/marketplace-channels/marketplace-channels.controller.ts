import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { MarketplaceChannelsService, UpdateMarketplaceChannelDto } from './marketplace-channels.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

@Controller('marketplace-channels')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class MarketplaceChannelsController {
  constructor(private readonly svc: MarketplaceChannelsService) {}

  @Get()
  @RequirePermission('integrations.view')
  list() {
    return this.svc.list()
  }

  @Patch(':id')
  @RequirePermission('settings.update')
  update(@Param('id') id: string, @Body() body: UpdateMarketplaceChannelDto) {
    return this.svc.update(id, body)
  }
}
