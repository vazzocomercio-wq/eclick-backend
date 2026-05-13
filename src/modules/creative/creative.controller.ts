import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, Logger, HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import {
  CreativeService,
  type CreateProductDto,
  type UpdateProductDto,
  type CreateBriefingDto,
} from './creative.service'
import { CreativeImagePipelineService } from './creative-image-pipeline.service'
import { CreativeVideoPipelineService } from './creative-video-pipeline.service'
import { CreativeMlPublisherService } from './creative-ml-publisher.service'
import {
  CreativePromptTemplatesService,
  TEMPLATE_VARIABLES,
} from './creative-prompt-templates.service'
import { CreativeReferencesService } from './creative-references.service'
import { CreativeTemplateResolutionService } from './creative-template-resolution.service'
import { CreativeTaxonomyService } from './creative-taxonomy.service'
import type { CreatePromptTemplateDto } from './dto/create-prompt-template.dto'
import type { UpdatePromptTemplateDto } from './dto/update-prompt-template.dto'
import type { PreviewTemplateDto } from './dto/preview-template.dto'
import type { TestTemplatePositionDto } from './dto/test-template-position.dto'
import type { CreateReferenceDto } from './dto/create-reference.dto'
import type { UpdateReferenceDto } from './dto/update-reference.dto'
import type { UploadReferenceDto } from './dto/upload-reference.dto'
import type { CreateTaxonomyDto, UpdateTaxonomyDto, TaxonomyKind } from './dto/taxonomy.dto'
import type { Marketplace } from './creative.marketplace-rules'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('creative')
@UseGuards(SupabaseAuthGuard)
export class CreativeController {
  private readonly logger = new Logger(CreativeController.name)

  constructor(
    private readonly svc:        CreativeService,
    private readonly images:     CreativeImagePipelineService,
    private readonly videos:     CreativeVideoPipelineService,
    private readonly mlPub:      CreativeMlPublisherService,
    private readonly templates:  CreativePromptTemplatesService,
    private readonly references: CreativeReferencesService,
    private readonly resolution: CreativeTemplateResolutionService,
    private readonly taxonomy:   CreativeTaxonomyService,
  ) {}

  private orgOrThrow(u: ReqUserPayload): string {
    if (!u.orgId) throw new BadRequestException('usuário sem organização ativa')
    return u.orgId
  }

  // ── Products ─────────────────────────────────────────────────────────────

  @Post('products')
  createProduct(@ReqUser() u: ReqUserPayload, @Body() body: CreateProductDto) {
    return this.svc.createProduct(this.orgOrThrow(u), u.id, body)
  }

  @Get('products')
  listProducts(
    @ReqUser() u: ReqUserPayload,
    @Query('status') status?: string,
    @Query('limit')  limit?: string,
    @Query('search') search?: string,
    @Query('sort')   sort?: 'recent' | 'name',
    @Query('include_archived') includeArchived?: string,
  ) {
    return this.svc.listProducts(this.orgOrThrow(u), {
      status,
      search,
      sort,
      include_archived: includeArchived === 'true' || includeArchived === '1',
      limit: limit ? Number(limit) : undefined,
    })
  }

  @Get('products/:id')
  getProduct(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.getProductWithSignedUrl(this.orgOrThrow(u), id)
  }

  @Patch('products/:id')
  updateProduct(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: UpdateProductDto) {
    return this.svc.updateProduct(this.orgOrThrow(u), id, body)
  }

  @Delete('products/:id')
  archiveProduct(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.archiveProduct(this.orgOrThrow(u), id)
  }

  @Post('products/:id/analyze')
  @HttpCode(HttpStatus.OK)
  analyzeProduct(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.analyzeProduct(this.orgOrThrow(u), id)
  }

  @Post('products/:id/to-catalog')
  @HttpCode(HttpStatus.OK)
  creativeToCatalog(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.creativeToCatalog(this.orgOrThrow(u), id)
  }

  // ── Briefings ────────────────────────────────────────────────────────────

  @Post('products/:id/briefings')
  createBriefing(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: CreateBriefingDto) {
    return this.svc.createBriefing(this.orgOrThrow(u), id, body)
  }

  @Get('products/:id/briefings')
  listBriefings(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.listBriefings(this.orgOrThrow(u), id)
  }

  @Patch('briefings/:id')
  updateBriefing(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.updateBriefing(this.orgOrThrow(u), id, body)
  }

  /** Gera (ou regenera) a base de prompts editaveis ligada ao briefing.
   *  Body opcional aceita { scope, override, imageCount, videoCount,
   *  videoDurationSec, videoAspectRatio }. */
  @Post('briefings/:id/generate-prompts')
  generatePromptsBase(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      scope?:             'image' | 'video' | 'both'
      override?:          { provider: 'anthropic' | 'openai'; model: string }
      imageCount?:        number
      videoCount?:        number
      videoDurationSec?:  5 | 10
      videoAspectRatio?:  '1:1' | '16:9' | '9:16'
    },
  ) {
    return this.svc.generatePromptsBase(this.orgOrThrow(u), id, {
      scope:             body?.scope ?? 'both',
      override:          body?.override,
      imageCount:        body?.imageCount,
      videoCount:        body?.videoCount,
      videoDurationSec:  body?.videoDurationSec,
      videoAspectRatio:  body?.videoAspectRatio,
    })
  }

  // ── Briefing templates (melhoria #2) ─────────────────────────────────────

  @Get('briefing-templates')
  listBriefingTemplates(@ReqUser() u: ReqUserPayload) {
    return this.svc.listBriefingTemplates(this.orgOrThrow(u))
  }

  @Post('briefing-templates')
  createBriefingTemplate(@ReqUser() u: ReqUserPayload, @Body() body: {
    name:                string
    description?:        string
    target_marketplace:  Marketplace
    visual_style?:       string
    environment?:        string
    custom_environment?: string
    background_color?:   string
    use_logo?:           boolean
    communication_tone?: string
    image_count?:        number
    image_format?:       string
    is_default?:         boolean
  }) {
    return this.svc.createBriefingTemplate(this.orgOrThrow(u), u.id, body)
  }

  @Patch('briefing-templates/:id')
  updateBriefingTemplate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.svc.updateBriefingTemplate(this.orgOrThrow(u), id, body)
  }

  @Delete('briefing-templates/:id')
  deleteBriefingTemplate(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.deleteBriefingTemplate(this.orgOrThrow(u), id)
  }

  @Get('products/:id/listings')
  listProductListings(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.listListingsByProduct(this.orgOrThrow(u), id)
  }

  // ── Listings ─────────────────────────────────────────────────────────────

  @Post('listings/generate')
  @HttpCode(HttpStatus.OK)
  generateListing(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { product_id: string; briefing_id: string },
  ) {
    if (!body?.product_id)  throw new BadRequestException('product_id obrigatório')
    if (!body?.briefing_id) throw new BadRequestException('briefing_id obrigatório')
    return this.svc.generateListing(this.orgOrThrow(u), body.product_id, body.briefing_id)
  }

  @Get('listings/:id')
  getListing(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.getListing(this.orgOrThrow(u), id)
  }

  @Patch('listings/:id')
  updateListing(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.svc.updateListing(this.orgOrThrow(u), id, body)
  }

  @Post('listings/:id/regenerate')
  @HttpCode(HttpStatus.OK)
  regenerateListing(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { instruction?: string },
  ) {
    return this.svc.regenerateListing(this.orgOrThrow(u), id, body?.instruction)
  }

  @Post('listings/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveListing(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.approveListing(this.orgOrThrow(u), id, u.id)
  }

  /** POST /listings/:id/refresh-ml-category — força re-predict da categoria ML. */
  @Post('listings/:id/refresh-ml-category')
  @HttpCode(HttpStatus.OK)
  refreshMlCategory(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.refreshMlCategory(this.orgOrThrow(u), id)
  }

  /** GET /ml/categories/:id/attributes-detail — retorna attributes formatados
   *  com flag `required` calculada (sub-sprint B vai usar pra ficha técnica). */
  @Get('ml/categories/:id/attributes-detail')
  getMlCategoryAttributesDetail(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    this.orgOrThrow(u) // só checa que user tem org (endpoint não precisa do orgId)
    return this.svc.getMlCategoryAttributes(id)
  }

  /** GET /ml/listing-types — modalidades de anúncio MLB (Free/Gold Especial/Pro). */
  @Get('ml/listing-types')
  listMlListingTypes(@ReqUser() u: ReqUserPayload) {
    this.orgOrThrow(u)
    return this.svc.listMlListingTypes()
  }

  @Post('listings/:id/variant')
  @HttpCode(HttpStatus.OK)
  createVariant(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { target_marketplace: Marketplace },
  ) {
    if (!body?.target_marketplace) throw new BadRequestException('target_marketplace obrigatório')
    return this.svc.createVariant(this.orgOrThrow(u), id, body.target_marketplace)
  }

  // ── Usage / cost ─────────────────────────────────────────────────────────

  @Get('usage')
  getUsage(@ReqUser() u: ReqUserPayload, @Query('days') days?: string) {
    return this.svc.getUsage(this.orgOrThrow(u), {
      sinceDays: days ? Math.max(1, Math.min(365, Number(days))) : undefined,
    })
  }

  // ── Image pipeline (E2) ──────────────────────────────────────────────────

  @Post('image-jobs')
  @HttpCode(HttpStatus.OK)
  createImageJob(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { product_id: string; briefing_id: string; listing_id?: string; count?: number; max_cost_usd?: number },
  ) {
    return this.images.createJob(this.orgOrThrow(u), u.id, body)
  }

  @Get('image-jobs/:id')
  getImageJob(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.getJob(this.orgOrThrow(u), id)
  }

  @Get('image-jobs/:id/images')
  listJobImages(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.listImagesByJob(this.orgOrThrow(u), id)
  }

  @Get('products/:id/image-jobs')
  listProductImageJobs(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.listJobsByProduct(this.orgOrThrow(u), id)
  }

  @Get('products/:id/images')
  listProductImages(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.listImagesByProduct(this.orgOrThrow(u), id)
  }

  @Post('image-jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelImageJob(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.cancelJob(this.orgOrThrow(u), id)
  }

  @Post('image-jobs/:id/regenerate-rejected')
  @HttpCode(HttpStatus.OK)
  regenerateRejectedImages(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.regenerateAllRejected(this.orgOrThrow(u), id)
  }

  @Post('images/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveImage(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.approveImage(this.orgOrThrow(u), id, u.id)
  }

  @Post('images/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectImage(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.images.rejectImage(this.orgOrThrow(u), id, u.id)
  }

  @Post('images/:id/regenerate')
  @HttpCode(HttpStatus.OK)
  regenerateImage(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { prompt?: string },
  ) {
    return this.images.regenerateImage(this.orgOrThrow(u), id, body?.prompt)
  }

  // ── Video pipeline (E3a) ─────────────────────────────────────────────────

  @Post('video-jobs')
  @HttpCode(HttpStatus.OK)
  createVideoJob(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      product_id:        string
      briefing_id:       string
      listing_id?:       string
      source_image_id?:  string
      count?:            number
      duration_seconds?: 5 | 10
      aspect_ratio?:     '1:1' | '16:9' | '9:16'
      model_name?:       'kling-v2-1' | 'kling-v2-1-master' | 'kling-v2-5' | 'kling-v2-6' | 'kling-v1-6'
      max_cost_usd?:     number
    },
  ) {
    return this.videos.createJob(this.orgOrThrow(u), u.id, body)
  }

  @Get('video-jobs/:id')
  getVideoJob(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.getJob(this.orgOrThrow(u), id)
  }

  @Get('video-jobs/:id/videos')
  listJobVideos(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.listVideosByJob(this.orgOrThrow(u), id)
  }

  @Get('products/:id/video-jobs')
  listProductVideoJobs(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.listJobsByProduct(this.orgOrThrow(u), id)
  }

  @Post('video-jobs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelVideoJob(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.cancelJob(this.orgOrThrow(u), id)
  }

  @Post('video-jobs/:id/regenerate-rejected')
  @HttpCode(HttpStatus.OK)
  regenerateRejectedVideos(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.regenerateAllRejected(this.orgOrThrow(u), id)
  }

  @Post('videos/:id/approve')
  @HttpCode(HttpStatus.OK)
  approveVideo(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.approveVideo(this.orgOrThrow(u), id, u.id)
  }

  @Post('videos/:id/reject')
  @HttpCode(HttpStatus.OK)
  rejectVideo(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.videos.rejectVideo(this.orgOrThrow(u), id, u.id)
  }

  @Post('videos/:id/regenerate')
  @HttpCode(HttpStatus.OK)
  regenerateVideo(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { prompt?: string },
  ) {
    return this.videos.regenerateVideo(this.orgOrThrow(u), id, body?.prompt)
  }

  // ── ML publisher (E3c F1+F2 — preview/mapping, sem publicar) ──────────────

  @Get('listings/:id/ml-context')
  getMlContext(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.mlPub.getPublishContext(this.orgOrThrow(u), id)
  }

  @Get('ml/predict-category')
  predictMlCategory(@ReqUser() u: ReqUserPayload, @Query('title') title: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!title)   throw new BadRequestException('title obrigatório')
    return this.mlPub.predictCategoryFromTitle(title)
  }

  @Get('ml/categories/:id/attributes')
  getMlCategoryAttributes(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.mlPub.getRequiredAttributes(id)
  }

  @Post('listings/:id/ml-preview')
  @HttpCode(HttpStatus.OK)
  buildMlPreview(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      image_ids:     string[]
      video_id?:     string | null
      price:         number
      stock:         number
      listing_type?: 'free' | 'gold_special' | 'gold_pro'
      category_id?:  string
      attributes?:   Array<{ id: string; value_name?: string; value_id?: string }>
      condition?:    'new' | 'used' | 'not_specified'
    },
  ) {
    return this.mlPub.buildPreview(this.orgOrThrow(u), id, body)
  }

  @Post('listings/:id/ml-publish')
  @HttpCode(HttpStatus.OK)
  publishMl(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: {
      idempotency_key: string
      image_ids:       string[]
      video_id?:       string | null
      price:           number
      stock:           number
      listing_type?:   'free' | 'gold_special' | 'gold_pro'
      category_id?:    string
      attributes?:     Array<{ id: string; value_name?: string; value_id?: string }>
      condition?:      'new' | 'used' | 'not_specified'
    },
  ) {
    if (!body?.idempotency_key) throw new BadRequestException('idempotency_key obrigatório')
    return this.mlPub.publishToMl(this.orgOrThrow(u), u.id, id, body)
  }

  @Get('listings/:id/publications')
  listListingPublications(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.mlPub.listPublicationsByListing(this.orgOrThrow(u), id)
  }

  @Get('publications/:id')
  getPublication(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.mlPub.getPublication(this.orgOrThrow(u), id)
  }

  @Post('publications/:id/sync')
  @HttpCode(HttpStatus.OK)
  syncPublication(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.mlPub.syncPublicationStatus(this.orgOrThrow(u), id)
  }

  @Get('publications/degraded')
  listDegradedPublications(@ReqUser() u: ReqUserPayload) {
    return this.mlPub.listDegradedPublications(this.orgOrThrow(u))
  }

  @Post('publications/:id/acknowledge-degradation')
  @HttpCode(HttpStatus.OK)
  acknowledgeDegradation(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.mlPub.acknowledgeDegradation(this.orgOrThrow(u), id, u.id)
  }

  // ════════════════════════════════════════════════════════════════════════
  // Sprint 2 — Prompt templates (por position)
  //
  // ⚠️ Ordem importa: literais (`/variables`, `/match`) DEVEM vir antes
  // dos catch-all `/:id` pra não serem hijackeados. Nest registra na ordem
  // de declaração das anotações.
  // ════════════════════════════════════════════════════════════════════════

  /** GET /creative/prompt-templates/variables — lista de {vars} disponíveis (estático). */
  @Get('prompt-templates/variables')
  listTemplateVariables() {
    return { variables: TEMPLATE_VARIABLES }
  }

  /** GET /creative/prompt-templates/match?product_id=X — escolhe melhor template pro produto. */
  @Get('prompt-templates/match')
  matchTemplateForProduct(@ReqUser() u: ReqUserPayload, @Query('product_id') productId?: string) {
    if (!productId) throw new BadRequestException('product_id obrigatório')
    return this.resolution.matchTemplateForProduct(this.orgOrThrow(u), productId)
  }

  /** GET /creative/prompt-templates — lista templates da org. */
  @Get('prompt-templates')
  listPromptTemplates(
    @ReqUser() u: ReqUserPayload,
    @Query('search') search?: string,
    @Query('category_ml_id') categoryMlId?: string,
  ) {
    return this.templates.list(this.orgOrThrow(u), { search, category_ml_id: categoryMlId })
  }

  /** POST /creative/prompt-templates — cria template. */
  @Post('prompt-templates')
  createPromptTemplate(@ReqUser() u: ReqUserPayload, @Body() body: CreatePromptTemplateDto) {
    return this.templates.create(this.orgOrThrow(u), u.id, body)
  }

  /** GET /creative/prompt-templates/:id — pega template por id. */
  @Get('prompt-templates/:id')
  getPromptTemplate(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.templates.getById(this.orgOrThrow(u), id)
  }

  /** PATCH /creative/prompt-templates/:id — atualiza template. */
  @Patch('prompt-templates/:id')
  updatePromptTemplate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdatePromptTemplateDto,
  ) {
    return this.templates.update(this.orgOrThrow(u), id, body)
  }

  /** DELETE /creative/prompt-templates/:id — apaga template (recusa se for default). */
  @Delete('prompt-templates/:id')
  deletePromptTemplate(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.templates.remove(this.orgOrThrow(u), id)
  }

  /** POST /creative/prompt-templates/:id/set-default — promove a default da org. */
  @Post('prompt-templates/:id/set-default')
  @HttpCode(HttpStatus.OK)
  setPromptTemplateDefault(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.templates.setDefault(this.orgOrThrow(u), id)
  }

  /** POST /creative/prompt-templates/:id/clone — duplica template (cópia não-default). */
  @Post('prompt-templates/:id/clone')
  @HttpCode(HttpStatus.OK)
  clonePromptTemplate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { name?: string },
  ) {
    return this.templates.clone(this.orgOrThrow(u), u.id, id, body?.name)
  }

  /** POST /creative/prompt-templates/:id/preview — renderiza prompts com vars + refs pra um produto. */
  @Post('prompt-templates/:id/preview')
  @HttpCode(HttpStatus.OK)
  previewPromptTemplate(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: PreviewTemplateDto,
  ) {
    return this.resolution.previewTemplate(this.orgOrThrow(u), id, body)
  }

  /**
   * POST /creative/prompt-templates/:id/positions/:position/test
   * Gera UMA imagem isolada pra essa position. Não persiste em creative_images
   * — sobe pro Storage em prefixo `tests/` e retorna signed URL TTL 1h.
   * Usado pelo editor de template ("Testar slot") pra iterar visual rápido.
   */
  @Post('prompt-templates/:id/positions/:position/test')
  @HttpCode(HttpStatus.OK)
  testPromptTemplatePosition(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Param('position') positionStr: string,
    @Body() body: TestTemplatePositionDto,
  ) {
    const position = Number(positionStr)
    if (!Number.isInteger(position) || position < 1) {
      throw new BadRequestException('position: inteiro >= 1')
    }
    return this.images.testSinglePosition(this.orgOrThrow(u), id, position, body)
  }

  // ════════════════════════════════════════════════════════════════════════
  // Sprint 2 — Reference library
  //
  // Mesma regra: literais (`/upload-url`, `/curated`, `/by-position`) antes
  // dos `/:id`.
  // ════════════════════════════════════════════════════════════════════════

  /** POST /creative/references/upload-url — gera signed write URL pra upload. */
  @Post('references/upload-url')
  @HttpCode(HttpStatus.OK)
  issueReferenceUploadUrl(@ReqUser() u: ReqUserPayload, @Body() body: UploadReferenceDto) {
    return this.references.issueUploadUrl(this.orgOrThrow(u), body)
  }

  /** GET /creative/references/curated — lista somente curated (compartilhados plataforma). */
  @Get('references/curated')
  listCuratedReferences(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    return this.references.list(this.orgOrThrow(u), {
      only_curated: true,
      limit: limit ? Number(limit) : undefined,
    })
  }

  /**
   * GET /creative/references/by-position?position=N&category_ml_id=Y&product_type=Z
   * Debug: lista refs que matchariam um position+category+product_type específico.
   * Útil pro editor de template ver o que iria entrar como ref dinâmica.
   */
  @Get('references/by-position')
  listReferencesByPosition(
    @ReqUser() u: ReqUserPayload,
    @Query('position')        positionStr?: string,
    @Query('category_ml_id')  categoryMlId?: string,
    @Query('product_type')    productType?: string,
    @Query('ambient')         ambient?: string,
    @Query('limit')           limit?: string,
  ) {
    const position = positionStr ? Number(positionStr) : undefined
    if (position !== undefined && (!Number.isInteger(position) || position < 1)) {
      throw new BadRequestException('position: inteiro >= 1 ou omitido')
    }
    return this.references.list(this.orgOrThrow(u), {
      position,
      category_ml_id: categoryMlId,
      product_type:   productType,
      ambient,
      include_curated: true,
      limit: limit ? Number(limit) : undefined,
    })
  }

  /** GET /creative/references — lista refs da org (+ curated se include_curated=1). */
  @Get('references')
  listReferences(
    @ReqUser() u: ReqUserPayload,
    @Query('search')           search?: string,
    @Query('tags')             tagsCsv?: string,
    @Query('category_ml_id')   categoryMlId?: string,
    @Query('product_type')     productType?: string,
    @Query('ambient')          ambient?: string,
    @Query('include_inactive') includeInactive?: string,
    @Query('include_curated')  includeCurated?: string,
    @Query('limit')            limit?: string,
  ) {
    return this.references.list(this.orgOrThrow(u), {
      search,
      tags:             tagsCsv ? tagsCsv.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      category_ml_id:   categoryMlId,
      product_type:     productType,
      ambient,
      include_inactive: includeInactive === 'true' || includeInactive === '1',
      include_curated:  includeCurated  === 'true' || includeCurated  === '1',
      limit: limit ? Number(limit) : undefined,
    })
  }

  /** POST /creative/references — cria row metadata (após upload completar). */
  @Post('references')
  createReference(@ReqUser() u: ReqUserPayload, @Body() body: CreateReferenceDto) {
    return this.references.create(this.orgOrThrow(u), u.id, body)
  }

  /** GET /creative/references/:id — pega ref com signed read URL. */
  @Get('references/:id')
  getReference(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.references.getById(this.orgOrThrow(u), id, { allowCurated: true })
  }

  /** PATCH /creative/references/:id — atualiza metadata (não curated). */
  @Patch('references/:id')
  updateReference(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateReferenceDto,
  ) {
    return this.references.update(this.orgOrThrow(u), id, body)
  }

  /** DELETE /creative/references/:id — hard delete + remove do Storage. */
  @Delete('references/:id')
  deleteReference(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.references.remove(this.orgOrThrow(u), id)
  }

  /** POST /creative/references/:id/toggle-active — alterna is_active. */
  @Post('references/:id/toggle-active')
  @HttpCode(HttpStatus.OK)
  toggleReferenceActive(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.references.toggleActive(this.orgOrThrow(u), id)
  }

  // ════════════════════════════════════════════════════════════════════════
  // Sprint 2 patch — Taxonomia customizável (ambient / product_type)
  //
  // Defaults globais (org_id=NULL) seedados via migration 20260554.
  // Cada org pode adicionar/editar/apagar SUAS opções; defaults read-only.
  // ════════════════════════════════════════════════════════════════════════

  /** GET /creative/taxonomy?kind=ambient|product_type[&include_hidden=1] */
  @Get('taxonomy')
  listTaxonomy(
    @ReqUser() u: ReqUserPayload,
    @Query('kind') kind: string,
    @Query('include_hidden') includeHidden?: string,
  ) {
    if (kind !== 'ambient' && kind !== 'product_type') {
      throw new BadRequestException('kind: ambient | product_type')
    }
    return this.taxonomy.list(this.orgOrThrow(u), kind as TaxonomyKind, {
      include_hidden: includeHidden === '1' || includeHidden === 'true',
    })
  }

  /** POST /creative/taxonomy/:id/hide — oculta da org (soft-delete reversível). */
  @Post('taxonomy/:id/hide')
  @HttpCode(HttpStatus.OK)
  hideTaxonomy(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.taxonomy.hideForOrg(this.orgOrThrow(u), u.id, id)
  }

  /** DELETE /creative/taxonomy/:id/hide — desfaz hide (mostra de novo). */
  @Delete('taxonomy/:id/hide')
  unhideTaxonomy(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.taxonomy.unhideForOrg(this.orgOrThrow(u), id)
  }

  /** POST /creative/taxonomy — cria custom da org. */
  @Post('taxonomy')
  createTaxonomy(@ReqUser() u: ReqUserPayload, @Body() body: CreateTaxonomyDto) {
    return this.taxonomy.create(this.orgOrThrow(u), u.id, body)
  }

  /** PATCH /creative/taxonomy/:id — atualiza. Se default, faz clone-on-modify. */
  @Patch('taxonomy/:id')
  updateTaxonomy(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: UpdateTaxonomyDto,
  ) {
    return this.taxonomy.update(this.orgOrThrow(u), id, u.id, body)
  }

  /** DELETE /creative/taxonomy/:id — apaga custom da org (não-default). */
  @Delete('taxonomy/:id')
  deleteTaxonomy(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.taxonomy.remove(this.orgOrThrow(u), id)
  }
}
