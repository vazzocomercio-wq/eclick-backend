import { Controller, Get, Put, Patch, Delete, Post, Param, Body, Query, UseGuards, UseInterceptors, UploadedFile, HttpCode, HttpStatus, BadRequestException, NotFoundException, Res } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { ProductsService, UpdateProductCostsDto, CreateVinculoDto, CreateStockMovementDto, UpdateStockDto } from './products.service'
import { ProductsEnrichmentService } from './products-enrichment.service'
import { ProductsImportService } from './products-import.service'
import { ProductsCompletenessService } from './products-completeness.service'
import { ProductsListingCoverageService } from './products-listing-coverage.service'
import { MlCategoryRequirementsService } from './ml-category-requirements.service'
import { ProductsCadastroDispatchService, type DispatchInput } from './products-cadastro-dispatch.service'
import { ActiveResolverService } from '../active-bridge/active-resolver.service'
import { CreativeService } from '../creative/creative.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { Public } from '../../common/decorators/public.decorator'
import { ReqUser } from '../../common/decorators/user.decorator'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

type UploadedXlsxFile = { originalname: string; size: number; buffer: Buffer; mimetype: string }

@Controller('products')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly creative: CreativeService,
    private readonly enrichment: ProductsEnrichmentService,
    private readonly importer: ProductsImportService,
    private readonly completeness: ProductsCompletenessService,
    private readonly coverage: ProductsListingCoverageService,
    private readonly mlReq: MlCategoryRequirementsService,
    private readonly cadastroDispatch: ProductsCadastroDispatchService,
    private readonly activeResolver:   ActiveResolverService,
  ) {}

  /** POST /products/storefront-visibility — Loja Propria Fase 9: envia ou
   *  remove produtos da vitrine /loja/[slug] em lote. */
  @Post('storefront-visibility')
  @RequirePermission('products.update')
  setStorefrontVisibility(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { productIds?: string[]; visible?: boolean },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.products.setStorefrontVisibility(
      u.orgId,
      body?.productIds ?? [],
      body?.visible === true,
    )
  }

  // ── Active config dropdowns (sessão 2026-05-14) ────────────────────────
  // Endpoints que populam os dropdowns do modal "Despachar pra operador"
  // sem o user precisar copiar UUIDs do schema active.* na mão.

  /** GET /products/active-config/agents — lista members ativos+convidados da org Active */
  @Get('active-config/agents')
  listActiveAgents(@ReqUser() u: ReqUserPayload) {
    if (!u.id) throw new BadRequestException('userId ausente')
    return this.activeResolver.listAgents(u.id)
  }

  /** GET /products/active-config/pipelines — lista pipelines da org Active */
  @Get('active-config/pipelines')
  listActivePipelines(@ReqUser() u: ReqUserPayload) {
    if (!u.id) throw new BadRequestException('userId ausente')
    return this.activeResolver.listPipelines(u.id)
  }

  /** GET /products/active-config/pipelines/:id/stages — lista stages de um pipeline */
  @Get('active-config/pipelines/:pipelineId/stages')
  listActivePipelineStages(
    @ReqUser() u: ReqUserPayload,
    @Param('pipelineId') pipelineId: string,
  ) {
    if (!u.id) throw new BadRequestException('userId ausente')
    if (!pipelineId?.trim()) throw new BadRequestException('pipelineId obrigatório')
    return this.activeResolver.listStages(u.id, pipelineId.trim())
  }

  // ── F4 (2026-05-14) — Despacho pra operador (cards no Active CRM) ──────

  /** POST /products/dispatch-to-operator — gestor seleciona N produtos +
   *  configura operador/pipeline; cria 1 card no Active por produto. */
  @Post('dispatch-to-operator')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  dispatchToOperator(@ReqUser() u: ReqUserPayload, @Body() body: DispatchInput) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.cadastroDispatch.dispatch(u.orgId, u.id, body)
  }

  /** POST /products/dispatch-to-publish — despacha produtos sem anúncio pro
   *  funil de Anúncios do Active; o operador cria/vincula o anúncio. */
  @Post('dispatch-to-publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  dispatchToPublish(@ReqUser() u: ReqUserPayload, @Body() body: DispatchInput) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.cadastroDispatch.dispatchToPublish(u.orgId, u.id, body)
  }

  /** GET /products/operator-assignments?status=open&operator=... */
  @Get('operator-assignments')
  listOperatorAssignments(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('operator') operator?: string,
    @Query('limit') limitRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '100', 10) || 100, 1), 500)
    return this.cadastroDispatch.list(u.orgId, { status, operator, limit })
  }

  /** POST /products/cadastro-callback — webhook do Active quando task completa.
   *  Auth via shared secret (mesmo X-Automation-Bridge-Token reverso). */
  @Post('cadastro-callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  async cadastroCallback(@Body() body: { task_id?: string; secret?: string }) {
    const expected = process.env.ACTIVE_CALLBACK_SECRET ?? process.env.ACTIVE_AUTOMATION_BRIDGE_SECRET
    if (!expected || body?.secret !== expected) {
      throw new BadRequestException('secret inválido')
    }
    if (!body.task_id) throw new BadRequestException('task_id obrigatório')
    return this.cadastroDispatch.markCompletedByTaskId(body.task_id)
  }

  /** POST /products/cadastro-deal-callback — webhook do Active quando o estado
   *  de um deal de cadastro muda (Ganho/Perdido/Em andamento). Cobre o caso de
   *  o operador mover o card no kanban sem completar a task. */
  @Post('cadastro-deal-callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  async cadastroDealCallback(
    @Body() body: { deal_id?: string; outcome?: string; secret?: string },
  ) {
    const expected = process.env.ACTIVE_CALLBACK_SECRET ?? process.env.ACTIVE_AUTOMATION_BRIDGE_SECRET
    if (!expected || body?.secret !== expected) {
      throw new BadRequestException('secret inválido')
    }
    if (!body.deal_id) throw new BadRequestException('deal_id obrigatório')
    if (body.outcome !== 'won' && body.outcome !== 'lost' && body.outcome !== 'in_progress') {
      throw new BadRequestException("outcome deve ser 'won', 'lost' ou 'in_progress'")
    }
    return this.cadastroDispatch.syncAssignmentByDealState(body.deal_id, body.outcome)
  }

  // ── F2 (2026-05-14) — Completeness check (universal + ML dinâmico) ─────

  /** GET /products/:id/completeness — avalia produto vs requisitos ML.
   *  Retorna { ready_for_ml, complete, missing_universal[], missing_ml_attrs[] }. */
  @Get(':id/completeness')
  async getCompleteness(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const product = await this.products.getById(id)
    return this.completeness.evaluate(product as any)
  }

  /** POST /products/:id/refresh-completeness — re-avalia + remove tag
   *  'cadastro_pendente' se ficou completo (ou readiciona se voltou). */
  @Post(':id/refresh-completeness')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async refreshCompleteness(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.completeness.refreshAndCleanupTag(id)
  }

  /** GET /products/completeness-summary — KPIs agregados pra dashboard.
   *  Retorna { total, incomplete_count, by_missing, sample_incomplete[] }.
   *  Aceita filtros (2026-05-14): stock_min, stock_max, search, sort, sample_size. */
  @Get('completeness-summary')
  async completenessSummary(
    @ReqUser() u: ReqUserPayload,
    @Query('limit')       limitRaw?:      string,
    @Query('sample_size') sampleSizeRaw?: string,
    @Query('stock_min')   stockMinRaw?:   string,
    @Query('stock_max')   stockMaxRaw?:   string,
    @Query('search')      search?:        string,
    @Query('sort')        sortRaw?:       string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const parseOpt = (s?: string): number | undefined => {
      if (!s) return undefined
      const n = parseInt(s, 10)
      return Number.isFinite(n) ? n : undefined
    }
    const limit       = Math.min(Math.max(parseOpt(limitRaw) ?? 500, 50), 2000)
    const sampleSize  = Math.min(Math.max(parseOpt(sampleSizeRaw) ?? 200, 10), 500)
    const sort: 'stock_desc' | 'stock_asc' | 'name' | undefined =
      sortRaw === 'stock_desc' || sortRaw === 'stock_asc' || sortRaw === 'name' ? sortRaw : undefined
    return this.completeness.evaluateBulk(u.orgId, {
      limit,
      sample_size: sampleSize,
      stock_min:   parseOpt(stockMinRaw),
      stock_max:   parseOpt(stockMaxRaw),
      search:      search?.trim() || undefined,
      sort,
    })
  }

  /** GET /products/listing-coverage — Operação de Cadastro: matriz produto ×
   *  destino (canal × conta). Identifica produtos sem anúncio ou com cobertura
   *  parcial multi-canal/multi-conta. */
  @Get('listing-coverage')
  async listingCoverage(
    @ReqUser() u: ReqUserPayload,
    @Query('sample_size') sampleSizeRaw?: string,
    @Query('stock_min')   stockMinRaw?:   string,
    @Query('stock_max')   stockMaxRaw?:   string,
    @Query('search')      search?:        string,
    @Query('sort')        sortRaw?:       string,
    @Query('coverage')    coverageRaw?:   string,
    @Query('only_complete') onlyCompleteRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const parseOpt = (s?: string): number | undefined => {
      if (!s) return undefined
      const n = parseInt(s, 10)
      return Number.isFinite(n) ? n : undefined
    }
    const sort: 'stock_desc' | 'stock_asc' | 'name' | undefined =
      sortRaw === 'stock_desc' || sortRaw === 'stock_asc' || sortRaw === 'name' ? sortRaw : undefined
    const coverage: 'sem' | 'parcial' | 'all' | undefined =
      coverageRaw === 'sem' || coverageRaw === 'parcial' || coverageRaw === 'all' ? coverageRaw : undefined
    return this.coverage.getCoverage(u.orgId, {
      sample_size:   parseOpt(sampleSizeRaw),
      stock_min:     parseOpt(stockMinRaw),
      stock_max:     parseOpt(stockMaxRaw),
      search:        search?.trim() || undefined,
      sort,
      coverage,
      only_complete: onlyCompleteRaw === 'true' || onlyCompleteRaw === '1',
    })
  }

  /** GET /products/ml-category-requirements?category_id=MLB... — required attrs */
  @Get('ml-category-requirements')
  async getMlCategoryRequirements(
    @ReqUser() u: ReqUserPayload,
    @Query('category_id') categoryId?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!categoryId) throw new BadRequestException('category_id obrigatório (formato MLB...)')
    return this.mlReq.getRequiredAttrs(categoryId)
  }

  /** GET /products/incomplete?limit=200 — lista produtos pendentes c/ missing_fields.
   *  Otimizado pra tela de operação de cadastro (F4). */
  @Get('incomplete')
  async listIncomplete(
    @ReqUser() u: ReqUserPayload,
    @Query('limit') limitRaw?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '200', 10) || 200, 10), 500)
    return this.completeness.evaluateBulk(u.orgId, limit)
  }

  // ── F1 (2026-05-14) — Upload de planilha de produtos ───────────────────

  /** POST /products/import/dry-run — multipart/form-data com file.
   * Parseia + mapeia colunas + conta criados vs skip, SEM INSERT. */
  @Post('import/dry-run')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importDryRun(
    @ReqUser() u: ReqUserPayload,
    @UploadedFile() file: UploadedXlsxFile | undefined,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!file) throw new BadRequestException('arquivo "file" obrigatório (multipart/form-data)')
    return this.importer.dryRun(u.orgId, file.buffer, file.originalname)
  }

  /** POST /products/import — executa import real. Cria batch + INSERT.
   *  Pula SKUs já existentes. Marca novos com tag 'cadastro_pendente'. */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importCommit(
    @ReqUser() u: ReqUserPayload,
    @UploadedFile() file: UploadedXlsxFile | undefined,
    @Body() body: { default_tag?: string } | undefined,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!file) throw new BadRequestException('arquivo "file" obrigatório (multipart/form-data)')
    return this.importer.commit(u.orgId, u.id, file.buffer, file.originalname, file.size, {
      defaultTag: body?.default_tag,
    })
  }

  /** GET /products/import-template — baixa .xlsx template com colunas sugeridas */
  @Get('import-template')
  importTemplate(@Res() res: Response) {
    const buf = this.importer.buildTemplate()
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', 'attachment; filename="eclick-produtos-template.xlsx"')
    res.send(buf)
  }

  /** GET /products/import-batches — histórico de uploads */
  @Get('import-batches')
  importBatches(@ReqUser() u: ReqUserPayload, @Query('limit') limitRaw?: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200)
    return this.importer.listBatches(u.orgId, limit)
  }

  // ── Onda 1 M2 — Enriquecimento AI do catálogo ───────────────────────────

  /** POST /products/:id/enrich — chama Sonnet pra preencher 9 campos AI. */
  @Post(':id/enrich')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  enrichProduct(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.enrichProduct(u.orgId, id)
  }

  /** POST /products/:id/recompute-score — reavalia score sem chamar AI. */
  @Post(':id/recompute-score')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  recomputeScore(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.recomputeScore(u.orgId, id)
  }

  /** POST /products/enrich-bulk (L1 hybrid C) — cria job pra batch
   *  enrichment. Worker dedicado processa, UI faz polling. Cap 200/job. */
  @Post('enrich-bulk')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  enrichBulk(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      product_ids?:        string[]
      missing_enrichment?: boolean
      ai_score_lt?:        number
      limit?:              number
      max_cost_usd?:       number
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.enrichBulk(u.orgId, u.id, body)
  }

  @Get('enrichment-jobs/:id')
  getEnrichmentJob(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.getEnrichmentJob(u.orgId, id)
  }

  @Post('enrichment-jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  cancelEnrichmentJob(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.cancelEnrichmentJob(u.orgId, id)
  }

  /** GET /products/enrichment-summary — KPIs de enriquecimento da org. */
  @Get('enrichment-summary')
  enrichmentSummary(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.enrichmentSummary(u.orgId)
  }

  /** GET /products/catalog-health — count de produtos por catalog_status. */
  @Get('catalog-health')
  catalogHealth(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.getCatalogHealth(u.orgId)
  }

  /** PATCH /products/:id/catalog-status — toggle paused/ready manual. */
  @Patch(':id/catalog-status')
  @RequirePermission('products.update')
  setCatalogStatus(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { status: 'paused' | 'ready' | 'draft' },
  ) {
    if (!u.orgId)        throw new BadRequestException('orgId ausente')
    if (!body?.status)   throw new BadRequestException('status obrigatório')
    return this.enrichment.setCatalogStatus(u.orgId, id, body.status)
  }

  /** POST /products/:id/apply-suggestions — copia ai_suggested_* pros campos
   *  oficiais (name, description, bullets, category). */
  @Post(':id/apply-suggestions')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  applySuggestions(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { title?: boolean; description?: boolean; bullets?: boolean; category?: boolean; all?: boolean },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.applySuggestions(u.orgId, id, body)
  }

  /** GET /products/recommendations (L3) — buckets de produtos que precisam atenção. */
  @Get('recommendations')
  getRecommendations(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.getRecommendations(u.orgId)
  }

  // ── L2 — Landing page pública ─────────────────────────────────────────────

  /** PATCH /products/:id/landing — toggle landing_published. */
  @Patch(':id/landing')
  @RequirePermission('products.update')
  setLanding(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { published: boolean },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.enrichment.setLandingPublished(u.orgId, id, !!body?.published)
  }

  /** GET /public/products/:id/landing — endpoint PÚBLICO (sem auth) usado
   *  pela rota /p/:id no frontend. 404 se não publicado. */
  @Get('/public/:id/landing')
  @Public()
  async getPublicLanding(@Param('id') id: string) {
    const product = await this.enrichment.getLandingProduct(id)
    if (!product) throw new NotFoundException('produto não disponível')
    return product
  }

  // ── Onda 1 M1 — Bridge com módulo IA Criativo ───────────────────────────

  /** GET /products/:id/creatives — lista creative_products vinculados ao produto. */
  @Get(':id/creatives')
  listProductCreatives(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.creative.listCreativesForCatalogProduct(u.orgId, id)
  }

  /** POST /products/:id/creative — cria criativo pré-preenchido com dados do
   *  produto. Body: { main_image_url, main_image_storage_path } (frontend
   *  faz upload primeiro pra bucket creative). */
  @Post(':id/creative')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  createCreativeFromProduct(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { main_image_url: string; main_image_storage_path: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.creative.createCreativeFromCatalogProduct(u.orgId, u.id, id, body)
  }

  // GET /products
  // Quando query params de paginação são passados (page, per_page, search, etc),
  // retorna envelope { data, total, page, per_page }. Sem params, retorna
  // array (back-compat com callers antigos como list/grid view).
  @Get()
  getAll(
    @ReqUser() user: ReqUserPayload,
    @Query('page')         page?:        string,
    @Query('per_page')     perPage?:     string,
    @Query('search')       search?:      string,
    @Query('quick_filter') quickFilter?: string,
    @Query('sort_by')      sortBy?:      string,
    @Query('sort_dir')     sortDir?:     string,
    @Query('stock_min')    stockMin?:    string,
    @Query('stock_max')    stockMax?:    string,
  ) {
    const paginated = page || perPage || search || quickFilter || sortBy || stockMin || stockMax
    if (!paginated) return this.products.getAll(user.orgId)
    const parseIntOpt = (s?: string): number | undefined => {
      if (!s) return undefined
      const n = parseInt(s, 10)
      return Number.isFinite(n) ? n : undefined
    }
    return this.products.listPaginated(user.orgId, {
      page:         page ? Number(page) : undefined,
      per_page:     perPage ? Number(perPage) : undefined,
      search,
      quick_filter: quickFilter,
      sort_by:      sortBy,
      sort_dir:     sortDir === 'asc' ? 'asc' : sortDir === 'desc' ? 'desc' : undefined,
      stock_min:    parseIntOpt(stockMin),
      stock_max:    parseIntOpt(stockMax),
    })
  }

  // GET /products/kpis — totais usados pelo painel "Catálogo" em /produtos
  @Get('kpis')
  getKpis(@ReqUser() user: ReqUserPayload) {
    return this.products.getKpis(user.orgId)
  }

  // GET /products/linked-listings  — must be before :id to avoid param capture
  @Get('linked-listings')
  getLinkedListingIds() {
    return this.products.getLinkedListingIds()
  }

  /** GET /products/tax-config — imposto padrão central da organização. */
  @Get('tax-config')
  getTaxConfig(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.products.getTaxConfig(user.orgId)
  }

  /** PUT /products/tax-config — salva o imposto padrão e, conforme `apply`,
   *  propaga pros produtos: 'all' = todos, 'only_empty' = só sem imposto,
   *  'none' = só salva o padrão (produtos sem imposto herdam no cálculo). */
  @Put('tax-config')
  @RequirePermission('settings.update')
  updateTaxConfig(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { tax_percentage?: number | null; tax_on_freight?: boolean; apply?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const apply = body.apply === 'all' || body.apply === 'only_empty' ? body.apply : 'none'
    const pct = body.tax_percentage == null ? null : Number(body.tax_percentage)
    if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
      throw new BadRequestException('tax_percentage deve estar entre 0 e 100')
    }
    return this.products.updateTaxConfig(user.orgId, {
      tax_percentage: pct,
      tax_on_freight: Boolean(body.tax_on_freight),
      apply,
    })
  }

  // POST /products/vinculos
  @Post('vinculos')
  @RequirePermission('products.update')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createVinculo(@Body() body: any) {
    return this.products.createVinculo(body)
  }

  // POST /products/vinculos/bulk — cria N vínculos do MESMO produto pra N
  // listings (cada um pode estar em conta ML diferente). Usado no fluxo da
  // página /catalogo/anuncios/mercadolivre onde o usuário seleciona vários
  // anúncios não-vinculados e escolhe um produto pra vincular todos de uma
  // vez. Resposta inclui per-listing status pra UI mostrar o que deu certo
  // e o que falhou (ex: vínculo já existia → skip).
  @Post('vinculos/bulk')
  @RequirePermission('products.update')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createVinculosBulk(@Body() body: any) {
    return this.products.createVinculosBulk(body)
  }

  // DELETE /products/vinculos/:id
  @Delete('vinculos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('products.delete')
  deleteVinculo(@Param('id') id: string) {
    return this.products.deleteVinculo(id)
  }

  // POST /products/stock/movement
  @Post('stock/movement')
  @RequirePermission('stock.adjust')
  createStockMovement(@ReqUser() user: ReqUserPayload, @Body() dto: CreateStockMovementDto) {
    return this.products.createStockMovement(dto, user.id)
  }

  // PATCH /products/stock/:id
  @Patch('stock/:id')
  @RequirePermission('stock.adjust')
  updateStock(@Param('id') id: string, @Body() dto: UpdateStockDto) {
    return this.products.updateStock(id, dto)
  }

  // GET /products/:id
  @Get(':id')
  getById(@Param('id') id: string) {
    return this.products.getById(id)
  }

  // PUT /products/:id  (full update)
  @Put(':id')
  @RequirePermission('products.update')
  updateFull(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.products.updateFull(id, body)
  }

  // PATCH /products/:id  (costs only)
  @Patch(':id')
  @RequirePermission('products.update')
  updateCosts(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateProductCostsDto,
  ) {
    return this.products.updateCosts(user.orgId ?? null, id, dto)
  }

  // DELETE /products/:id
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('products.delete')
  deleteProduct(@Param('id') id: string) {
    return this.products.deleteProduct(id)
  }

  // POST /products/bulk-delete  { ids: string[] }
  @Post('bulk-delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('products.delete')
  bulkDelete(@Body() body: { ids: string[] }) {
    return this.products.deleteMany(body.ids)
  }

  /** POST /products/bulk-update-costs
   *
   *  Atualiza cost_price + tax_percentage de produtos do catálogo,
   *  matched por SKU. Aceita até 1000 rows por chamada.
   *
   *  Body: {
   *    rows: Array<{ sku: string; cost_price?: number; tax_percentage?: number; tax_on_freight?: boolean }>
   *  }
   *
   *  Retorna: { updated, not_found, errors, not_found_skus[], error_details[] }
   */
  @Post('bulk-update-costs')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  bulkUpdateCosts(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      rows: Array<{
        sku:               string
        cost_price?:       number | null
        tax_percentage?:   number | null
        tax_on_freight?:   boolean
      }>
    },
  ) {
    const rows = body?.rows ?? []
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('rows obrigatório (≥1)')
    }
    if (rows.length > 1000) {
      throw new BadRequestException('Máximo 1000 rows por chamada')
    }
    return this.products.bulkUpdateCostsBySku(user.orgId ?? null, rows)
  }
}
