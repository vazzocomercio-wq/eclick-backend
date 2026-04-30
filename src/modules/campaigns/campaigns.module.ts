import { Module } from '@nestjs/common'
import { MessagingModule } from '../messaging/messaging.module'
import { CredentialsModule } from '../credentials/credentials.module'
import { AiModule } from '../ai/ai.module'
import { MarketplaceScrapingModule } from '../marketplace-scraping/marketplace-scraping.module'
import { CanvaOauthModule } from '../canva-oauth/canva-oauth.module'
import { CampaignsController } from './campaigns.controller'
import { CampaignsService } from './campaigns.service'
import { CampaignAssetsService } from './campaign-assets.service'

@Module({
  imports: [
    MessagingModule,
    CredentialsModule,
    AiModule,
    MarketplaceScrapingModule,
    CanvaOauthModule,
  ],
  controllers: [CampaignsController],
  providers:   [CampaignsService, CampaignAssetsService],
  exports:     [CampaignsService],
})
export class CampaignsModule {}
