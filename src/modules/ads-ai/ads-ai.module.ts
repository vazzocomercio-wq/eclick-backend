import { Module } from '@nestjs/common'
import { AdsAiController } from './ads-ai.controller'
import { AdsAiService } from './ads-ai.service'
import { ContextBuilderService } from './services/context-builder.service'
import { InsightDetectorService } from './services/insight-detector.service'
import { AiChatService } from './services/ai-chat.service'
import { WhatsAppAlerterService } from './services/whatsapp-alerter.service'
import { CredentialsModule } from '../credentials/credentials.module'
import { WhatsAppModule } from '../whatsapp/whatsapp.module'

@Module({
  imports:     [CredentialsModule, WhatsAppModule],
  controllers: [AdsAiController],
  providers:   [AdsAiService, ContextBuilderService, InsightDetectorService, AiChatService, WhatsAppAlerterService],
  exports:     [AdsAiService, ContextBuilderService, InsightDetectorService, AiChatService],
})
export class AdsAiModule {}
