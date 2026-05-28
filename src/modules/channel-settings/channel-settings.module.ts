import { Module } from '@nestjs/common'
import { ChannelSettingsController } from './channel-settings.controller'
import { ChannelSettingsService } from './channel-settings.service'

@Module({
  controllers: [ChannelSettingsController],
  providers: [ChannelSettingsService],
  exports: [ChannelSettingsService],
})
export class ChannelSettingsModule {}
