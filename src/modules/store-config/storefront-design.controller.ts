import {
  Controller, Post, Put, Body, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { StorefrontDesignService } from './storefront-design.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Loja Propria — Fase 2: Designer de loja com IA.
 *
 *   POST /store/config/design/generate             { prompt, inspirationId? }
 *   POST /store/config/design/generate-from-image  { imageBase64, imageMimeType?, prompt? }
 *   POST /store/config/design/hero-image           { prompt? }
 *   PUT  /store/config/design                      { design }
 */
@Controller('store/config/design')
@UseGuards(SupabaseAuthGuard)
export class StorefrontDesignController {
  constructor(private readonly svc: StorefrontDesignService) {}

  @Post('generate')
  generate(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { prompt?: string; inspirationId?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateDesign(u.orgId, {
      prompt:        body?.prompt ?? '',
      inspirationId: body?.inspirationId,
    })
  }

  @Post('generate-from-image')
  generateFromImage(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { imageBase64?: string; imageMimeType?: string; prompt?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.imageBase64) throw new BadRequestException('imageBase64 obrigatório')
    return this.svc.generateFromImage(u.orgId, {
      imageBase64:   body.imageBase64,
      imageMimeType: body.imageMimeType,
      prompt:        body.prompt,
    })
  }

  @Post('hero-image')
  generateHeroImage(@ReqUser() u: ReqUserPayload, @Body() body: { prompt?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateHeroImage(u.orgId, { prompt: body?.prompt })
  }

  @Put()
  save(@ReqUser() u: ReqUserPayload, @Body() body: { design?: unknown }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.saveDesign(u.orgId, body?.design)
  }
}
