import {
  Controller, Get, Post, Patch, Body, Param, Query,
  UseGuards, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common'
import {
  KitsService, type ProductKit, type KitType, type KitStatus,
} from './kits.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Onda 4 / A5 — Kits & Combos.
 *
 * POST   /kits/generate           → IA gera kits
 * GET    /kits                    → listar
 * GET    /kits/:id                → detalhe
 * PATCH  /kits/:id                → editar
 * POST   /kits/:id/approve        → aprova
 * POST   /kits/:id/activate       → publica
 * POST   /kits/:id/pause          → pausa
 * POST   /kits/:id/archive        → arquiva
 */
@Controller('kits')
@UseGuards(SupabaseAuthGuard)
export class KitsController {
  constructor(private readonly svc: KitsService) {}

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  generate(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { count?: number; types?: KitType[]; product_ids?: string[] } = {},
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generate(u.orgId, body)
  }

  @Get()
  list(
    @ReqUser() u: ReqUserPayload,
    @Query('status')   status?:   KitStatus,
    @Query('kit_type') kit_type?: KitType,
    @Query('limit')    limitRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId, {
      status, kit_type,
      limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
    })
  }

  @Get(':id')
  get(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.get(id, u.orgId)
  }

  @Patch(':id')
  update(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<ProductKit>,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(id, u.orgId, body)
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approve(id, u.orgId)
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.activate(id, u.orgId)
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.pause(id, u.orgId)
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.archive(id, u.orgId)
  }
}
