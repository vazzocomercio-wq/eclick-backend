import {
  Controller, Get, Post, Put, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { MlPostsaleService } from './ml-postsale.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import type { SlaState } from './helpers/sla-state'

interface ReqUserPayload { id: string; orgId: string | null }

const SLA_STATES: SlaState[] = ['green', 'yellow', 'orange', 'red', 'critical', 'resolved']

@Controller('ml/postsale')
@UseGuards(SupabaseAuthGuard)
export class MlPostsaleController {
  constructor(private readonly svc: MlPostsaleService) {}

  // ── Listagem + dashboard ────────────────────────────────────────────────

  @Get('conversations')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('unread') unread?: string,
    @Query('sla')    sla?: string,
    @Query('search') search?: string,
    @Query('limit')  limit?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    const slaState = sla && (SLA_STATES as readonly string[]).includes(sla)
      ? (sla as SlaState)
      : undefined
    return this.svc.listConversations(u.orgId, {
      status,
      unread: unread === 'true' || unread === '1',
      sla:    slaState,
      search,
      limit:  limit ? Math.min(500, Math.max(1, parseInt(limit, 10) || 100)) : undefined,
    })
  }

  @Get('dashboard/sla')
  slaDashboard(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.slaDashboard(u.orgId)
  }

  // ── Detalhe + ações da conversa ─────────────────────────────────────────

  @Get('conversations/:id')
  detail(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.getConversationDetail(u.orgId, id)
  }

  @Post('conversations/:id/suggest')
  @HttpCode(HttpStatus.OK)
  regenerateSuggestion(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.regenerateSuggestion(u.orgId, id)
  }

  @Post('conversations/:id/suggest/transform')
  @HttpCode(HttpStatus.OK)
  transformTone(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { text: string; tone: 'mais_empatico' | 'mais_objetivo' },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    if (!body?.text)                                throw new BadRequestException('text obrigatório')
    if (!['mais_empatico', 'mais_objetivo'].includes(body.tone)) {
      throw new BadRequestException('tone inválido')
    }
    void id // o transform é puro, não depende da conversa
    return this.svc.transformTone(u.orgId, body.text, body.tone)
  }

  @Post('conversations/:id/send')
  @HttpCode(HttpStatus.OK)
  send(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      text:           string
      suggestion_id?: string
      action?:        'sent_as_is' | 'sent_edited'
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.sendMessage(u.orgId, id, {
      text:         body.text,
      suggestionId: body.suggestion_id,
      action:       body.action,
      actedBy:      u.id,
    })
  }

  @Post('conversations/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.markResolved(u.orgId, id, u.id)
  }

  // ── Knowledge base por produto ─────────────────────────────────────────

  @Get('knowledge/:product_id')
  getKnowledge(@ReqUser() u: ReqUserPayload, @Param('product_id') productId: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.getKnowledgeByProductId(u.orgId, productId)
  }

  @Put('knowledge/:product_id')
  @HttpCode(HttpStatus.OK)
  saveKnowledge(
    @ReqUser() u: ReqUserPayload,
    @Param('product_id') productId: string,
    @Body() body: {
      manual?:           string
      problemas_comuns?: string
      garantia?:         string
      politica_troca?:   string
      observacoes?:      string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente no JWT')
    return this.svc.upsertKnowledge(u.orgId, productId, { ...body, updated_by: u.id })
  }
}
