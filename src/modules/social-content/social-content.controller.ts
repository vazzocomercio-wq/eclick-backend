import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, BadRequestException,
  HttpCode, HttpStatus,
} from '@nestjs/common'
import { SocialContentService } from './social-content.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import type {
  SocialChannel,
  SocialContentStatus,
} from './social-content.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 3 / S1 — Social Content Generator endpoints (8 total).
 *
 * POST   /social/products/:id/generate
 * POST   /social/products/generate-batch
 * GET    /social/content
 * GET    /social/content/:id
 * PATCH  /social/content/:id
 * POST   /social/content/:id/regenerate
 * POST   /social/content/:id/approve
 * POST   /social/content/:id/schedule
 * DELETE /social/content/:id   (= archive)
 */
@Controller('social')
@UseGuards(SupabaseAuthGuard)
export class SocialContentController {
  constructor(private readonly svc: SocialContentService) {}

  /** POST /social/products/:id/generate — gera conteúdo pra 1 produto. */
  @Post('products/:id/generate')
  @HttpCode(HttpStatus.OK)
  generateForProduct(
    @ReqUser() u: ReqUserPayload,
    @Param('id') productId: string,
    @Body() body: { channels: SocialChannel[]; style?: string },
  ) {
    if (!u.orgId)              throw new BadRequestException('orgId ausente')
    if (!body?.channels?.length) throw new BadRequestException('channels obrigatório')
    return this.svc.generateForProduct({
      orgId:    u.orgId,
      userId:   u.id,
      productId,
      channels: body.channels,
      style:    body.style,
    })
  }

  /** POST /social/products/generate-batch — N produtos × N canais. */
  @Post('products/generate-batch')
  @HttpCode(HttpStatus.OK)
  generateBatch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      productIds: string[]
      channels:   SocialChannel[]
      style?:     string
    },
  ) {
    if (!u.orgId)                  throw new BadRequestException('orgId ausente')
    if (!body?.productIds?.length) throw new BadRequestException('productIds obrigatório')
    if (!body?.channels?.length)   throw new BadRequestException('channels obrigatório')
    return this.svc.generateBatch({
      orgId:      u.orgId,
      userId:     u.id,
      productIds: body.productIds,
      channels:   body.channels,
      style:      body.style,
    })
  }

  /** GET /social/content?channel=&product_id=&status=&limit=&offset= */
  @Get('content')
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('channel')    channel?:    SocialChannel,
    @Query('product_id') productId?:  string,
    @Query('status')     status?:     SocialContentStatus,
    @Query('limit')      limitRaw?:   string,
    @Query('offset')     offsetRaw?:  string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const limit  = limitRaw  ? parseInt(limitRaw, 10)  : undefined
    const offset = offsetRaw ? parseInt(offsetRaw, 10) : undefined
    return this.svc.list({ orgId: u.orgId, channel, productId, status, limit, offset })
  }

  /** GET /social/content/:id */
  @Get('content/:id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(id, u.orgId)
  }

  /** PATCH /social/content/:id — edita content/creative ids/scheduled_at. */
  @Patch('content/:id')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(id, u.orgId, body)
  }

  /** POST /social/content/:id/regenerate — refaz com instrução. */
  @Post('content/:id/regenerate')
  @HttpCode(HttpStatus.OK)
  regenerate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { instruction: string },
  ) {
    if (!u.orgId)               throw new BadRequestException('orgId ausente')
    if (!body?.instruction)     throw new BadRequestException('instruction obrigatório')
    return this.svc.regenerate(id, u.orgId, body.instruction)
  }

  /** POST /social/content/:id/approve */
  @Post('content/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approve(id, u.orgId)
  }

  /** POST /social/content/:id/schedule body { scheduled_at: ISO } */
  @Post('content/:id/schedule')
  @HttpCode(HttpStatus.OK)
  schedule(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { scheduled_at: string },
  ) {
    if (!u.orgId)               throw new BadRequestException('orgId ausente')
    if (!body?.scheduled_at)    throw new BadRequestException('scheduled_at obrigatório')
    return this.svc.schedule(id, u.orgId, body.scheduled_at)
  }

  /** DELETE /social/content/:id — arquiva (soft). */
  @Delete('content/:id')
  archive(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.archive(id, u.orgId)
  }
}
