import {
  Controller, Post, Body, UseGuards, BadRequestException, Logger,
  HttpCode, HttpStatus,
} from '@nestjs/common'
import { InternalKeyGuard } from './internal-key.guard'
import { EventsGateway } from '../events/events.gateway'
import { AlertResponseService } from '../intelligence-hub/delivery/alert-response.service'

interface RealtimeBody {
  org_id: string
  event: string
  payload: unknown
}

interface MessageNewPayload {
  channel_id?:        string
  wa_jid?:            string
  phone?:             string | null
  channel_message_id?: string
  content?: { kind: string; body?: string } & Record<string, unknown>
}

interface InboundProcessedBody {
  org_id: string
  channel_id: string
  channel_message_id: string
  wa_jid?: string
  phone?: string | null
  sender_name?: string | null
  content: { kind: string } & Record<string, unknown>
}

/**
 * Recebe broadcasts do worker Baileys e delega pro EventsGateway emitir
 * via Socket.IO. NÃO usa JWT do user — auth via X-Internal-Key.
 *
 * SupabaseAuthGuard NÃO é global no SaaS — só InternalKeyGuard precisa estar
 * aplicado aqui. Não usamos @Public() porque não há guard global pra bypassar.
 */
@Controller('internal')
@UseGuards(InternalKeyGuard)
export class InternalController {
  private readonly logger = new Logger(InternalController.name)

  constructor(
    private readonly events:        EventsGateway,
    private readonly alertResponse: AlertResponseService,
  ) {}

  @Post('realtime')
  @HttpCode(HttpStatus.OK)
  realtime(@Body() body: RealtimeBody) {
    if (!body?.org_id || !body?.event) {
      throw new BadRequestException('org_id e event obrigatórios')
    }
    this.events.emitToOrg(body.org_id, body.event, body.payload)

    // Tenta interpretar mensagens inbound como resposta a alerta do Intelligence
    // Hub. Best-effort, fire-and-forget — não bloqueia o broadcast realtime.
    if (body.event === 'message:new') {
      const payload = (body.payload ?? {}) as MessageNewPayload
      if (payload.content?.kind === 'text' && payload.content.body) {
        void this.alertResponse
          .handleInbound(body.org_id, payload.phone ?? null, payload.content.body)
          .catch(err => this.logger.warn(`[alert-response] erro: ${(err as Error).message}`))
      }
    }

    return { ok: true }
  }

  @Post('inbound-processed')
  @HttpCode(HttpStatus.OK)
  inboundProcessed(@Body() body: InboundProcessedBody) {
    if (!body?.org_id || !body?.channel_id) {
      throw new BadRequestException('org_id e channel_id obrigatórios')
    }
    // TODO futuro: disparar pipeline IA (classify+suggest) e automations
    // (trigger=message_received) quando módulo CRM existir.
    this.logger.log(
      `[inbound-processed] org=${body.org_id} channel=${body.channel_id} kind=${body.content?.kind} jid=${body.wa_jid}`,
    )
    return { ok: true }
  }
}
