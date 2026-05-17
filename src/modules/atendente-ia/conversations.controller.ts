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
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.getConversation(u.orgId!, id)
  }

  @Get(':id/messages')
  messages(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.getMessages(u.orgId!, id)
  }

  @Post(':id/messages')
  sendMessage(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { content: string },
  ) {
    return this.svc.sendHumanMessage(u.orgId!, id, u.id, body.content)
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @ReqUser() u: ReqUserPayload,
    @Param('id') convId: string,
    @Body() body: { message_id: string; content?: string },
  ) {
    return this.svc.approveSuggestion(u.orgId!, convId, body.message_id, u.id, body.content)
  }

  @Post(':id/discard-suggestion')
  @HttpCode(HttpStatus.OK)
  discard(
    @ReqUser() u: ReqUserPayload,
    @Param('id') convId: string,
    @Body() body: { message_id: string },
  ) {
    return this.svc.discardSuggestion(u.orgId!, convId, body.message_id)
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.resolve(u.orgId!, id)
  }

  @Post(':id/escalate')
  @HttpCode(HttpStatus.OK)
  escalate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { assign_to?: string },
  ) {
    return this.svc.escalate(id, body.assign_to, u.orgId!)
  }
}
