import {
  Controller, Post, Body, UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import { StoreCopilotService } from './store-copilot.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import type { ChatMessage } from './store-copilot.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 4 / A4 — Copiloto da Loja (admin assistant).
 *
 * POST /store-copilot/message
 *   body: { message, history?, auto_confirm? }
 *   Returns: { intent, message, requires_confirmation, params,
 *              executed, execution_result, cost_usd }
 */
@Controller('store-copilot')
@UseGuards(SupabaseAuthGuard)
export class StoreCopilotController {
  constructor(private readonly svc: StoreCopilotService) {}

  @Post('message')
  @HttpCode(HttpStatus.OK)
  message(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      message:       string
      history?:      ChatMessage[]
      auto_confirm?: boolean
    },
  ) {
    if (!u.orgId)            throw new BadRequestException('orgId ausente')
    if (!body?.message)      throw new BadRequestException('message obrigatório')
    return this.svc.message({
      orgId:        u.orgId,
      userId:       u.id,
      message:      body.message,
      history:      body.history,
      auto_confirm: body.auto_confirm,
    })
  }
}
