import {
  Controller, Post, Get, Body, Query, Param, UseGuards, BadRequestException, Logger,
  HttpCode, HttpStatus,
} from '@nestjs/common'
import { InternalKeyGuard } from './internal-key.guard'
import { EventsGateway } from '../events/events.gateway'
import { AlertResponseService } from '../intelligence-hub/delivery/alert-response.service'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { CanvaOauthService } from '../canva-oauth/canva-oauth.service'
import { SocialVideoBridgeService, StartReelDto } from './social-video-bridge.service'

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
    private readonly mercadolivre:  MercadolivreService,
    private readonly canva:         CanvaOauthService,
    private readonly socialVideo:   SocialVideoBridgeService,
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

  /**
   * Token ML + sellers próprios da org — consumido pelo coletor do e-Click
   * Radar IA (eclick-workers). O token fica fonte única aqui (refresh +
   * multi-conta via MercadolivreService); o worker não reimplementa OAuth.
   */
  @Get('ml/token')
  async mlToken(@Query('org_id') orgId: string) {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    const tokens = await this.mercadolivre.getAllTokensForOrg(orgId)
    return {
      token:          tokens[0].token,
      own_seller_ids: tokens.map(t => t.sellerId),
    }
  }

  /**
   * Lista os designs do Canva da org — consumido pela ponte do Active Social
   * AI Studio (usuário escolhe um design pra virar a imagem do post). Token +
   * refresh ficam fonte única no SaaS; o Active só proxia via X-Internal-Key.
   */
  @Get('canva/designs')
  async canvaDesigns(
    @Query('org_id') orgId: string,
    @Query('q') q?: string,
  ) {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    const designs = await this.canva.listDesigns(orgId, q)
    return { designs }
  }

  /**
   * Exporta um design do Canva como PNG, sobe pro bucket público e devolve a
   * URL https estável (o Instagram recusa imagens http / efêmeras).
   */
  @Post('canva/export')
  @HttpCode(HttpStatus.OK)
  async canvaExport(@Body() body: { org_id?: string; design_id?: string }) {
    if (!body?.org_id || !body?.design_id) {
      throw new BadRequestException('org_id e design_id obrigatórios')
    }
    return this.canva.exportDesignToPublicUrl(body.org_id, body.design_id)
  }

  /**
   * Social AI Studio (Active) → gera um REEL a partir de um produto reusando
   * o pipeline de vídeo do `creative`. Esconde creative_products/briefings/
   * images. Assíncrono: devolve job_id; o Active faz poll no GET abaixo.
   */
  @Post('creative/social-video')
  @HttpCode(HttpStatus.OK)
  async startSocialVideo(
    @Body() body: { org_id?: string; user_id?: string | null } & Partial<StartReelDto>,
  ) {
    if (!body?.org_id) throw new BadRequestException('org_id obrigatório')
    if (!body?.product_photo_url) throw new BadRequestException('product_photo_url obrigatório')
    if (!body?.prompt) throw new BadRequestException('prompt obrigatório')
    return this.socialVideo.startReel(body.org_id, body.user_id ?? null, body as StartReelDto)
  }

  /** Status do job de reel; quando completed devolve a URL pública estável. */
  @Get('creative/social-video/:jobId')
  async getSocialVideo(
    @Param('jobId') jobId: string,
    @Query('org_id') orgId: string,
  ) {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    return this.socialVideo.getReel(orgId, jobId)
  }

  /** E3 — Reel multi-cena: gera 1 clipe por foto; devolve job_ids. */
  @Post('creative/social-video-multi')
  @HttpCode(HttpStatus.OK)
  async startSocialVideoMulti(
    @Body() body: { org_id?: string; user_id?: string | null; photo_urls?: string[] } & Partial<StartReelDto>,
  ) {
    if (!body?.org_id) throw new BadRequestException('org_id obrigatório')
    if (!body?.photo_urls?.length) throw new BadRequestException('photo_urls obrigatório')
    if (!body?.prompt) throw new BadRequestException('prompt obrigatório')
    return this.socialVideo.startMultiSceneReel(
      body.org_id,
      body.user_id ?? null,
      body as StartReelDto & { photo_urls: string[] },
    )
  }

  /** Status do multi-cena: job_ids separados por vírgula; concatena quando prontos. */
  @Get('creative/social-video-multi')
  async getSocialVideoMulti(
    @Query('org_id') orgId: string,
    @Query('job_ids') jobIds: string,
  ) {
    if (!orgId) throw new BadRequestException('org_id obrigatório')
    const ids = (jobIds ?? '').split(',').map(s => s.trim()).filter(Boolean)
    return this.socialVideo.getMultiSceneReel(orgId, ids)
  }
}
