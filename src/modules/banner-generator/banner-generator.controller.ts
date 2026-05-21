import { Controller, Get, Post, Delete, Param, Query, Body, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { BannerGeneratorService } from './banner-generator.service'
import type { BannerGenerateInput } from './banner-generator.types'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Gerador de banners por IA usando produtos da loja como contexto.
 *
 *   GET  /banner-generator/styles                       → catalogo de estilos
 *   GET  /banner-generator/products?q=&limit=           → produtos visiveis da loja
 *   POST /banner-generator/generate                     → gera banner(s)
 */
@Controller('banner-generator')
@UseGuards(SupabaseAuthGuard)
export class BannerGeneratorController {
  constructor(private readonly svc: BannerGeneratorService) {}

  @Get('styles')
  listStyles() {
    return { styles: this.svc.listStyles() }
  }

  @Get('products')
  listProducts(
    @ReqUser() u: ReqUserPayload,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listProducts(u.orgId, {
      q,
      limit: limit ? parseInt(limit, 10) : undefined,
    }).then(products => ({ products }))
  }

  @Post('generate')
  generate(@ReqUser() u: ReqUserPayload, @Body() body: BannerGenerateInput) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateBanner(u.orgId, body)
  }

  /** GET /banner-generator/history?format=&limit=&offset= — galeria */
  @Get('history')
  history(
    @ReqUser() u: ReqUserPayload,
    @Query('format') format?: string,
    @Query('limit')  limit?:  string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listHistory(u.orgId, {
      format,
      limit:  limit  ? parseInt(limit,  10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    })
  }

  /** DELETE /banner-generator/:id — remove do histórico */
  @Delete(':id')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.deleteBanner(u.orgId, id)
  }
}
