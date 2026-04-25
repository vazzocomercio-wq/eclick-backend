import { Module } from '@nestjs/common'
import { AgentsService } from './agents.service'
import { AgentsController } from './agents.controller'
import { ConversationsService } from './conversations.service'
import { ConversationsController } from './conversations.controller'
import { AiResponderService } from './ai-responder.service'

@Module({
  controllers: [AgentsController, ConversationsController],
  providers: [AgentsService, ConversationsService, AiResponderService],
  exports: [AgentsService, ConversationsService, AiResponderService],
})
export class AtendenteIaModule {}
