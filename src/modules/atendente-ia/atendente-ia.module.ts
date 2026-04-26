import { Module } from '@nestjs/common'
import { AgentsService } from './agents.service'
import { AgentsController } from './agents.controller'
import { ConversationsService } from './conversations.service'
import { ConversationsController } from './conversations.controller'
import { AiResponderService } from './ai-responder.service'
import { AiSettingsService } from './ai-settings.service'
import { AiSettingsController } from './ai-settings.controller'
import { AiKnowledgeService } from './ai-knowledge.service'
import { AiKnowledgeController } from './ai-knowledge.controller'
import { CredentialsModule } from '../credentials/credentials.module'
import { MercadolivreModule } from '../mercadolivre/mercadolivre.module'
import { AiUsageModule } from '../ai-usage/ai-usage.module'

@Module({
  imports: [CredentialsModule, MercadolivreModule, AiUsageModule],
  controllers: [AgentsController, ConversationsController, AiSettingsController, AiKnowledgeController],
  providers: [AgentsService, ConversationsService, AiResponderService, AiSettingsService, AiKnowledgeService],
  exports: [AgentsService, ConversationsService, AiResponderService, AiSettingsService, AiKnowledgeService],
})
export class AtendenteIaModule {}
