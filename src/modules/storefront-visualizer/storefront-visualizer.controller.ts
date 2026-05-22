import {
  Controller, Get, Post, Put, Body, Param, Headers, Req, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { Request } from 'express'
import { Public } from '../../common/decorators/public.decorator'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { StorefrontVisualizerService, type VisualizerSettings } from './storefront-visualizer.service'
import { hashIp } from '../storefront-leads/storefront-leads.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * AH1 — endpoints públicos do Ambientador IA (gate de cadastro + OTP).
 *
 *   GET  /public/store/by-slug/:slug/visualizer/config
 *   POST /public/store/by-slug/:slug/visualizer/register   { name, email, phone }
 *   POST /public/store/by-slug/:slug/visualizer/verify     { phone, code }
 *   GET  /public/store/by-slug/:slug/visualizer/me         (header X-Visualizer-Token)
 *
 * O endpoint de geração (AH2) e a entrega (AH3) entram depois neste controller.
 */
@Controller('public/store/by-slug')
export class StorefrontVisualizerPublicController {
  constructor(private readonly svc: StorefrontVisualizerService) {}

  @Get(':slug/visualizer/config')
  @Public()
  config(@Param('slug') slug: string) {
    return this.svc.config(slug)
  }

  @Post(':slug/visualizer/register')
  @Public()
  register(
    @Req() req: Request,
    @Param('slug') slug: string,
    @Body() body: { name?: string; email?: string; phone?: string },
  ) {
    if (!body?.name || !body?.email || !body?.phone) {
      throw new BadRequestException('Preencha nome, e-mail e WhatsApp.')
    }
    const ip = String(
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()
      ?? req.socket?.remoteAddress ?? '',
    )
    return this.svc.register({
      slug,
      name:   body.name,
      email:  body.email,
      phone:  body.phone,
      ipHash: ip ? hashIp(ip) : null,
    })
  }

  @Post(':slug/visualizer/verify')
  @Public()
  verify(
    @Param('slug') slug: string,
    @Body() body: { phone?: string; code?: string },
  ) {
    if (!body?.phone || !body?.code) {
      throw new BadRequestException('Informe o telefone e o código.')
    }
    return this.svc.verify({ slug, phone: body.phone, code: body.code })
  }

  @Get(':slug/visualizer/me')
  @Public()
  me(@Headers('x-visualizer-token') token?: string) {
    if (!token) throw new BadRequestException('Sessão ausente.')
    return this.svc.me(token)
  }

  @Post(':slug/visualizer/generate')
  @Public()
  generate(
    @Headers('x-visualizer-token') token: string | undefined,
    @Body() body: {
      productId?:        string
      productName?:      string
      sceneImageBase64?: string
      sceneWidth?:       number
      sceneHeight?:      number
    },
  ) {
    if (!token) throw new BadRequestException('Sessão ausente. Refaça o cadastro.')
    if (!body?.productId) throw new BadRequestException('Produto não informado.')
    if (!body?.sceneImageBase64) throw new BadRequestException('Envie uma foto do ambiente.')
    return this.svc.generate({
      token,
      productId:        body.productId,
      productName:      body.productName,
      sceneImageBase64: body.sceneImageBase64,
      sceneWidth:       body.sceneWidth,
      sceneHeight:      body.sceneHeight,
    })
  }
}

/**
 * Lojista (dashboard) — config, galeria, clientes, créditos.
 *
 *   GET  /storefront-visualizer            → settings + stats + gerações + clientes
 *   PUT  /storefront-visualizer/settings   → atualiza config
 *   POST /storefront-visualizer/customers/:id/grant-credits  { amount }
 */
@Controller('storefront-visualizer')
@UseGuards(SupabaseAuthGuard)
export class StorefrontVisualizerOwnerController {
  constructor(private readonly svc: StorefrontVisualizerService) {}

  @Get()
  view(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.ownerView(u.orgId)
  }

  @Put('settings')
  updateSettings(@ReqUser() u: ReqUserPayload, @Body() body: Partial<VisualizerSettings>) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.ownerUpdateSettings(u.orgId, body ?? {})
  }

  @Post('customers/:id/grant-credits')
  grant(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { amount?: number },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.grantCredits(u.orgId, id, Number(body?.amount ?? 0))
  }
}
