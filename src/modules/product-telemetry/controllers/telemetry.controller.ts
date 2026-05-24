import { Controller, Post, Body, Req } from '@nestjs/common'
import { Request } from 'express'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { EventIngestionService, RawTelemetryEvent } from '../services/event-ingestion.service'
import { SessionService } from '../services/session.service'

interface ReqUserPayload { id: string; orgId: string }

/**
 * Ingestão de telemetria de produto. Autenticado pelo SupabaseAuthGuard
 * global — org_id e user_id vêm do JWT (@ReqUser), o client só manda o
 * session_id + os eventos. Nunca confiar em org/user vindos do body.
 */
@Controller('telemetry')
export class TelemetryController {
  constructor(
    private readonly ingestion: EventIngestionService,
    private readonly sessions:   SessionService,
  ) {}

  /** POST /telemetry/events — batch de eventos do dashboard. */
  @Post('events')
  async trackBatch(
    @ReqUser() user: ReqUserPayload,
    @Req() req: Request,
    @Body() body: { session_id?: string; device_type?: string; events?: RawTelemetryEvent[] },
  ): Promise<{ accepted: number; rejected: number }> {
    const ip = String(
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket?.remoteAddress ?? '',
    )
    return this.ingestion.ingestBatch({
      orgId:      user.orgId,
      userId:     user.id,
      sessionId:  body?.session_id ?? '',
      events:     Array.isArray(body?.events) ? body.events : [],
      userAgent:  req.headers['user-agent'] as string | undefined,
      ip:         ip || undefined,
      deviceType: body?.device_type,
    })
  }

  /** POST /telemetry/events/end-session — fecha a sessão e calcula duração. */
  @Post('events/end-session')
  async endSession(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { session_id?: string },
  ): Promise<{ ended: boolean }> {
    return this.sessions.end({ orgId: user.orgId, userId: user.id, sessionId: body?.session_id ?? '' })
  }
}
