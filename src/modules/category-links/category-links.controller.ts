import { Controller, Get, Post, Delete, Body, Param, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CategoryLinksService } from './category-links.service'

interface ReqUserPayload { id: string; orgId: string | null }

/**
 * Cat-5 — Vínculos de categoria (catálogo-produto). Tudo autenticado + escopo
 * por org. Mapeia categoria ML → categoria de outro marketplace.
 *
 *   GET    /category-links?target=meta
 *   GET    /category-links/sources                 — categorias ML da org + vínculos
 *   GET    /category-links/target/:mkt/browse?parent=
 *   GET    /category-links/target/:mkt/search?q=
 *   POST   /category-links/suggest                 — sugestão IA
 *   POST   /category-links                         — cria/atualiza vínculo
 *   DELETE /category-links/:id
 */
@Controller('category-links')
@UseGuards(SupabaseAuthGuard)
export class CategoryLinksController {
  constructor(private readonly svc: CategoryLinksService) {}

  @Get()
  list(@ReqUser() u: ReqUserPayload, @Query('target') target?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(u.orgId, target)
  }

  @Get('sources')
  sources(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listSourceCategories(u.orgId)
  }

  @Get('target/:mkt/browse')
  browse(@Param('mkt') mkt: string, @Query('parent') parent?: string) {
    return this.svc.browseTarget(mkt, parent || null)
  }

  @Get('target/:mkt/search')
  search(@Param('mkt') mkt: string, @Query('q') q: string) {
    return this.svc.searchTarget(mkt, q ?? '')
  }

  @Post('suggest')
  suggest(@ReqUser() u: ReqUserPayload, @Body() body: { sourceCategoryId?: string; targetMarketplace?: string }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.sourceCategoryId || !body?.targetMarketplace) {
      throw new BadRequestException('sourceCategoryId e targetMarketplace obrigatórios')
    }
    return this.svc.suggest(u.orgId, body.sourceCategoryId, body.targetMarketplace)
  }

  @Post()
  upsert(@ReqUser() u: ReqUserPayload, @Body() body: {
    sourceCategoryId?: string; sourceMarketplace?: string
    targetMarketplace?: string; targetCategoryId?: string
    status?: 'confirmed' | 'suggested'
  }) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.sourceCategoryId || !body?.targetMarketplace || !body?.targetCategoryId) {
      throw new BadRequestException('sourceCategoryId, targetMarketplace e targetCategoryId obrigatórios')
    }
    return this.svc.upsert(u.orgId, {
      sourceCategoryId:  body.sourceCategoryId,
      sourceMarketplace: body.sourceMarketplace,
      targetMarketplace: body.targetMarketplace,
      targetCategoryId:  body.targetCategoryId,
      status:            body.status,
      createdBy:         u.id,
    })
  }

  @Delete(':id')
  remove(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(u.orgId, id)
  }
}
