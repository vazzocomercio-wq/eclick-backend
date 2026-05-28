import { Controller, Get, Post, Body, Param, Query, UseGuards, BadRequestException, HttpCode, HttpStatus } from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'
import { CategoryResearchService } from './services/category-research.service'
import { ExistingListingOptimizerService } from './services/existing-listing-optimizer.service'
import { FeedbackLoopService } from './services/feedback-loop.service'

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
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class EOtimizerController {
  constructor(
    private readonly researchSvc: CategoryResearchService,
    private readonly optimizer:   ExistingListingOptimizerService,
    private readonly feedback:    FeedbackLoopService,
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
  @RequirePermission('products.view')
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

  /**
   * MVP 4 — analisa um anúncio ML existente. Retorna permissões + score atual +
   * sugestões da IA. NÃO aplica nada (criar registro em listing_optimizations).
   */
  @Post('listings/:mlbId/analyze')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  analyzeListing(@ReqUser() user: AuthUser, @Param('mlbId') mlbId: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    if (!mlbId?.trim()) throw new BadRequestException('mlbId obrigatório')
    return this.optimizer.analyze(user.orgId, mlbId.trim())
  }

  /**
   * MVP 4 — aplica as sugestões via PUT /items/{mlbId}. Defesa em
   * profundidade: re-valida permissões no backend mesmo o frontend
   * tendo bloqueado.
   */
  @Post('listings/optimizations/:optimizationId/apply')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.publish_ml')
  applyOptimization(
    @ReqUser() user: AuthUser,
    @Param('optimizationId') optimizationId: string,
    @Body() body: {
      apply_title?:        boolean
      apply_description?:  boolean
      apply_attributes?:   boolean
      custom_title?:       string
      custom_description?: string
      custom_attributes?:  Array<{ id: string; value_name: string }>
    },
  ) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.optimizer.apply(user.orgId, optimizationId, body)
  }

  /**
   * MVP 4 — histórico de otimizações da org (pra UI de tracking).
   */
  @Get('listings/optimizations/history')
  @RequirePermission('products.view')
  optimizationHistory(@ReqUser() user: AuthUser, @Query('limit') limit?: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    const lim = limit ? Math.min(Math.max(1, Number(limit)), 200) : 50
    return this.optimizer.listHistory(user.orgId, lim)
  }

  /**
   * MVP 5 — resumo agregado do feedback loop pra dashboard.
   * Retorna stats de quanto as otimizações estão de fato impactando vendas.
   */
  @Get('feedback/summary')
  @RequirePermission('products.view')
  feedbackSummary(@ReqUser() user: AuthUser) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.feedback.getSummary(user.orgId)
  }

  /**
   * MVP 5 — captura manual de métricas pra uma otimização específica.
   * Útil pra testar antes do cron diário rodar.
   */
  @Post('feedback/:optimizationId/capture')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  captureMetrics(@ReqUser() user: AuthUser, @Param('optimizationId') optId: string) {
    if (!user.orgId) throw new BadRequestException('Usuário sem org')
    return this.feedback.captureMetrics(user.orgId, optId)
  }
}
