import {
  Controller, Get, Post, Param, Query, Body, UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'
import { ShopeeChatService } from './shopee-chat.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Fase B pós-venda — Chat Shopee (sellerchat) no Atendimento.
 *  Mesmo vocabulário de permissões do ml-postsale: crm.view lê,
 *  crm.message envia/sugere. */
@Controller('shopee/chat')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeChatController {
  constructor(private readonly chat: ShopeeChatService) {}

  @Get('conversations')
  @RequirePermission('crm.view')
  async list(@ReqUser() user: ReqUserPayload, @Query('unread') unread?: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.chat.listConversations(user.orgId, { unread: unread === 'true' })
  }

  @Get('conversations/:id')
  @RequirePermission('crm.view')
  async detail(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.chat.getConversation(user.orgId, id)
  }

  /** ⚠️ Envia mensagem REAL pro comprador na Shopee. */
  @Post('conversations/:id/send')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  async send(@ReqUser() user: ReqUserPayload, @Param('id') id: string, @Body() body: { text?: string }) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.chat.send(user.orgId, id, body?.text ?? '')
  }

  /** IA: gera resposta sugerida pro contexto da conversa (não envia nada). */
  @Post('conversations/:id/suggest')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.message')
  async suggest(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.chat.suggest(user.orgId, id)
  }

  /** Sync manual (mesma rotina do cron, sob demanda). */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('crm.view')
  async sync(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.chat.syncChats(user.orgId)
  }
}
