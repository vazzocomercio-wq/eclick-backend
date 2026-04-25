import {
  Controller, Get, Post, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { ConversationsService } from './conversations.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('atendente-ia/conversations')
@UseGuards(SupabaseAuthGuard)
export class ConversationsController {
  constructor(private readonly svc: ConversationsService) {}

  @Get()
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status')   status?: string,
    @Query('channel')  channel?: string,
    @Query('agent_id') agentId?: string,
    @Query('search')   search?: string,
    @Query('limit')    limit?: string,
    @Query('offset')   offset?: string,
  ) {
    return this.svc.list({
      orgId: u.orgId!,
      status,
      channel,
      agent_id: agentId,
      search,
      limit:  limit  ? Number(limit)  : 50,
      offset: offset ? Number(offset) : 0,
    })
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.getConversation(id)
  }

  @Get(':id/messages')
  messages(@Param('id') id: string) {
    return this.svc.getMessages(id)
  }

  @Post(':id/messages')
  sendMessage(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { content: string },
  ) {
    return this.svc.sendHumanMessage(id, u.id, body.content)
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @ReqUser() u: ReqUserPayload,
    @Param('id') convId: string,
    @Body() body: { message_id: string; content?: string },
  ) {
    return this.svc.approveSuggestion(convId, body.message_id, u.id, body.content)
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(@Param('id') id: string) {
    return this.svc.resolve(id)
  }

  @Post(':id/escalate')
  @HttpCode(HttpStatus.OK)
  escalate(
    @Param('id') id: string,
    @Body() body: { assign_to?: string },
  ) {
    return this.svc.escalate(id, body.assign_to)
  }
}
