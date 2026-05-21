import {
  Controller, Get, Post, Put, Body, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { StorefrontDesignService } from './storefront-design.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Loja Propria — Designer de loja com IA (Fases 2/5/6/7 + section-image/upload-asset).
 *
 *   POST /store/config/design/generate             { prompt, inspirationId? }
 *   POST /store/config/design/generate-from-image  { imageBase64, imageMimeType?, prompt? }
 *   POST /store/config/design/generate-from-url    { url, prompt? }
 *   POST /store/config/design/hero-image           { prompt? }
 *   POST /store/config/design/section-image        { sectionIndex, slot?, prompt?, imageBase64?, imageMimeType? }
 *   POST /store/config/design/scene-image          { prompt, format? }   ← gera sem mutar design
 *   POST /store/config/design/upload-asset         { imageBase64, imageMimeType? }
 *   GET  /store/config/design/canva/designs        ?query=
 *   POST /store/config/design/canva/generate       { designId, prompt? }
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

  @Post('generate-from-url')
  generateFromUrl(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { url?: string; prompt?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.url) throw new BadRequestException('url obrigatória')
    return this.svc.generateFromUrl(u.orgId, { url: body.url, prompt: body.prompt })
  }

  @Post('hero-image')
  generateHeroImage(@ReqUser() u: ReqUserPayload, @Body() body: { prompt?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateHeroImage(u.orgId, { prompt: body?.prompt })
  }

  @Post('section-image')
  generateSectionImage(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      sectionIndex?:  number
      slot?:          string
      prompt?:        string
      imageBase64?:   string
      imageMimeType?: string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (typeof body?.sectionIndex !== 'number') {
      throw new BadRequestException('sectionIndex obrigatório')
    }
    return this.svc.generateSectionImage(u.orgId, {
      sectionIndex:  body.sectionIndex,
      slot:          body.slot,
      prompt:        body.prompt,
      imageBase64:   body.imageBase64,
      imageMimeType: body.imageMimeType,
    })
  }

  @Post('scene-image')
  generateSceneImage(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { prompt?: string; format?: 'wide' | 'square' | 'story' },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.prompt?.trim()) throw new BadRequestException('prompt obrigatório')
    return this.svc.generateSceneImage(u.orgId, {
      prompt: body.prompt,
      format: body.format,
    })
  }

  @Post('upload-asset')
  uploadAsset(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { imageBase64?: string; imageMimeType?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.imageBase64) throw new BadRequestException('imageBase64 obrigatório')
    return this.svc.uploadAsset(u.orgId, {
      imageBase64:   body.imageBase64,
      imageMimeType: body.imageMimeType,
    })
  }

  @Get('canva/designs')
  listCanvaDesigns(@ReqUser() u: ReqUserPayload, @Query('query') query?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listCanvaDesigns(u.orgId, query)
  }

  @Post('canva/generate')
  generateFromCanva(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { designId?: string; prompt?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.designId) throw new BadRequestException('designId obrigatório')
    return this.svc.generateFromCanvaDesign(u.orgId, {
      designId: body.designId,
      prompt:   body.prompt,
    })
  }

  @Put()
  save(@ReqUser() u: ReqUserPayload, @Body() body: { design?: unknown }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.saveDesign(u.orgId, body?.design)
  }
}
