import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CategoryResearchService } from './services/category-research.service'

interface AuthUser { id: string; orgId: string | null }

/**
 * e-Otimizer IA — endpoints públicos.
 *
 * MVP 1: research engine de categoria ML — base pra IA gerar títulos,
 * descrições e atributos otimizados (consumido pelo Creative.generateListing
 * e pelo Optimizer de anúncios existentes).
 *
 * Endpoints futuros:
 *   MVP 2: hookado dentro de POST /creative/listings (transparente)
 *   MVP 3: GET /e-otimizer/listings/:mlb_id/optimize (anúncio existente)
 *   MVP 4: cron + dashboards de feedback loop
 */
@Controller('e-otimizer')
@UseGuards(SupabaseAuthGuard)
export class EOtimizerController {
  constructor(
    private readonly researchSvc: CategoryResearchService,
  ) {}

  /**
   * Roda research de uma categoria + query. Cache 24h por (org, cat, query).
   *
   * Query params:
   *   categoryId   — ID ML (ex: 'MLB1234')  [obrigatório]
   *   q            — palavras-chave         [obrigatório]
   *   userKeywords — CSV adicional pra relevance scoring (opcional)
   *   excludeSellers — CSV de nicknames pra excluir (default: 'VAZZO_')
   *   refresh      — força regenerar mesmo com cache (default: false)
   */
  @Get('research')
  research(
    @ReqUser() user: AuthUser,
    @Query('categoryId') categoryId: string,
    @Query('q') query: string,
    @Query('userKeywords') userKeywordsCsv?: string,
    @Query('excludeSellers') excludeSellersCsv?: string,
    @Query('refresh') refresh?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!categoryId?.trim()) throw new BadRequestException('categoryId obrigatório')
    if (!query?.trim())      throw new BadRequestException('q obrigatório')

    const userKeywords = userKeywordsCsv
      ?.split(',').map(s => s.trim()).filter(Boolean) ?? []
    const excludeSellerNicknames = excludeSellersCsv
      ?.split(',').map(s => s.trim()).filter(Boolean)
      ?? ['VAZZO_']   // default: exclui própria marca Vazzo

    return this.researchSvc.research({
      orgId:      user.orgId,
      categoryId,
      query:      query.trim(),
      userKeywords,
      excludeSellerNicknames,
      refresh:    refresh === 'true',
    })
  }
}
