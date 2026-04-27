import { Controller, Get, Post, Patch, Body, Param, Query, Res, UseGuards, Logger, HttpCode, HttpStatus } from '@nestjs/common'
import type { Response } from 'express'
import { AdsAiService, AdsAiSettings } from './ads-ai.service'
import { InsightDetectorService } from './services/insight-detector.service'
import { AiChatService } from './services/ai-chat.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('ads-ai')
@UseGuards(SupabaseAuthGuard)
export class AdsAiController {
  private readonly logger = new Logger(AdsAiController.name)

  constructor(
    private readonly svc: AdsAiService,
    private readonly detector: InsightDetectorService,
    private readonly chat: AiChatService,
  ) {}

  private async safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn() } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[ads-ai] ${label}: ${err?.message}`)
      return fallback
    }
  }

  // ── Settings + models ──
  @Get('settings')
  settings(@ReqUser() u: ReqUserPayload) {
    return this.safe('settings', () => this.svc.getSettings(u.orgId ?? ''), null)
  }

  @Patch('settings')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: Partial<AdsAiSettings>) {
    return this.safe('settings.update', () => this.svc.updateSettings(u.orgId ?? '', body), null)
  }

  @Get('models/available')
  models() { return this.svc.availableModels() }

  // ── Insights ──
  @Get('insights')
  insights(
    @ReqUser() u: ReqUserPayload,
    @Query('status')   status?: string,
    @Query('severity') severity?: string,
    @Query('type')     type?: string,
  ) {
    return this.safe('insights.list',
      () => this.svc.listInsights(u.orgId ?? '', { status, severity, type }), [])
  }

  @Post('insights/detect')
  @HttpCode(HttpStatus.OK)
  detect(@ReqUser() u: ReqUserPayload) {
    return this.safe('insights.detect',
      async () => ({ found: await this.detector.detect(u.orgId ?? '') }),
      { found: 0 })
  }

  @Patch('insights/:id/dismiss')
  dismiss(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.safe('insights.dismiss', () => this.svc.dismissInsight(u.orgId ?? '', id), null)
  }

  @Patch('insights/:id/resolve')
  resolve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.safe('insights.resolve', () => this.svc.resolveInsight(u.orgId ?? '', id), null)
  }

  // ── Conversations ──
  @Get('conversations')
  conversations(@ReqUser() u: ReqUserPayload) {
    return this.safe('conversations.list', () => this.svc.listConversations(u.orgId ?? ''), [])
  }

  @Post('conversations')
  createConversation(@ReqUser() u: ReqUserPayload, @Body() body: { title?: string; model?: string }) {
    return this.safe('conversations.create',
      () => this.svc.createConversation(u.orgId ?? '', u.id, body.title ?? null, body.model ?? null), null)
  }

  @Get('conversations/:id/messages')
  messages(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.safe('conversations.messages', () => this.svc.listMessages(u.orgId ?? '', id), [])
  }

  /** Send a user message + stream the assistant reply via SSE.
   * Frontend should consume with EventSource or fetch+ReadableStream and
   * parse `event: delta` / `event: done` / `event: error` lines. */
  @Post('conversations/:id/messages')
  async sendMessage(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { message: string },
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    try {
      const text = (body?.message ?? '').toString().trim()
      if (!text) {
        send('error', { message: 'Mensagem vazia' })
        res.end()
        return
      }
      const result = await this.chat.runTurn(u.orgId ?? '', id, text)
      // Single coherent chunk — server resolved tool calls before emitting.
      send('delta', { text: result.text })
      send('done', {
        tool_calls: result.tool_calls,
        tokens_in:  result.tokens_in,
        tokens_out: result.tokens_out,
      })
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[ads-ai.chat] ${err?.message}`)
      send('error', { message: err?.message ?? 'Erro durante o turno' })
    } finally {
      res.end()
    }
  }
}
