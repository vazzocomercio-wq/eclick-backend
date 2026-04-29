import { Module } from '@nestjs/common'
import { MessagingModule } from '../messaging/messaging.module'
import { CredentialsModule } from '../credentials/credentials.module'
import { AiModule } from '../ai/ai.module'
import { CampaignsController } from './campaigns.controller'
import { CampaignsService } from './campaigns.service'

@Module({
  imports:     [MessagingModule, CredentialsModule, AiModule],
  controllers: [CampaignsController],
  providers:   [CampaignsService],
  exports:     [CampaignsService],
})
export class CampaignsModule {}
