import { Module } from '@nestjs/common'
import { EmailSettingsController } from './email-settings.controller'
import { EmailSettingsService } from './email-settings.service'

@Module({
  controllers: [EmailSettingsController],
  providers:   [EmailSettingsService],
  exports:     [EmailSettingsService],
})
export class EmailSettingsModule {}
