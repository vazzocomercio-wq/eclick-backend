import { Controller, Get, Post, Query, Body, UseGuards, BadRequestException } from '@nestjs/common'
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
}
