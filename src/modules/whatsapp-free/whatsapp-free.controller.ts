import {
  Controller, Get, Post, Body, Headers, Res, Req, UseGuards,
  BadRequestException, UnauthorizedException, HttpCode, HttpStatus,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { WhatsAppFreeService } from './whatsapp-free.service'

interface ReqUserPayload { id: string; orgId: string | null }

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY

/** Sprint F5-3 / Batch 1 — controller WhatsApp Gratuito.
 *
 * Rotas autenticadas (frontend): /status, /connect, /disconnect, /events
 * Rotas internas (worker → API): /internal/qr, /internal/status — auth por
 * x-internal-key (mesma do worker, NÃO via Supabase guard). */
@Controller('whatsapp-free')
export class WhatsAppFreeController {
  constructor(private readonly svc: WhatsAppFreeService) {}

  // ── Auth via Supabase JWT ──────────────────────────────────────────────

  @Get('status')
  @UseGuards(SupabaseAuthGuard)
  async status(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getStatus(u.orgId)
  }

  @Post('connect')
  @UseGuards(SupabaseAuthGuard)
  async connect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.createSession(u.orgId)
  }

  @Post('disconnect')
  @UseGuards(SupabaseAuthGuard)
  async disconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.disconnectSession(u.orgId)
  }

  /** SSE stream — emite eventos `qr` e `status` pra UI. */
  @Get('events')
  @UseGuards(SupabaseAuthGuard)
  async events(
    @ReqUser() u: ReqUserPayload,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!u.orgId) throw new BadRequestException('orgId ausente')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')   // desabilita buffering em proxies
    res.flushHeaders()

    // Snapshot inicial pro frontend ter estado imediato
    const status = await this.svc.getStatus(u.orgId)
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`)

    this.svc.addSseClient(u.orgId, res)
    // Mantém connection aberta — request fecha quando frontend desconecta
    req.on('close', () => {
      // service já cuida de remover via res.on('close'), mas req.on('close') é
      // mais confiável em alguns setups
      try { res.end() } catch { /* ignore */ }
    })
  }

  // ── Internal (worker → API) — auth por x-internal-key ──────────────────

  @Post('internal/qr')
  @Public()
  @HttpCode(HttpStatus.OK)
  async internalQr(
    @Headers('x-internal-key') key: string | undefined,
    @Body() body: { orgId: string; qrBase64: string },
  ) {
    this.assertInternalKey(key)
    if (!body?.orgId || !body?.qrBase64) {
      throw new BadRequestException('orgId e qrBase64 obrigatórios')
    }
    this.svc.emitSse(body.orgId, 'qr', { qrBase64: body.qrBase64 })
    return { ok: true }
  }

  @Post('internal/status')
  @Public()
  @HttpCode(HttpStatus.OK)
  async internalStatus(
    @Headers('x-internal-key') key: string | undefined,
    @Body() body: { orgId: string; status: string; phone?: string; name?: string; error?: string },
  ) {
    this.assertInternalKey(key)
    if (!body?.orgId || !body?.status) {
      throw new BadRequestException('orgId e status obrigatórios')
    }
    this.svc.emitSse(body.orgId, 'status', {
      status: body.status,
      phone: body.phone ?? null,
      name: body.name ?? null,
      error: body.error ?? null,
    })
    return { ok: true }
  }

  private assertInternalKey(received: string | undefined): void {
    if (!INTERNAL_API_KEY) {
      throw new UnauthorizedException('INTERNAL_API_KEY não configurada no servidor')
    }
    if (received !== INTERNAL_API_KEY) {
      throw new UnauthorizedException('x-internal-key inválido')
    }
  }
}
