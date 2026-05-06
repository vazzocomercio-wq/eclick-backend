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
import type { Marketplace } from './creative.marketplace-rules'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('creative')
@UseGuards(SupabaseAuthGuard)
export class CreativeController {
  private readonly logger = new Logger(CreativeController.name)

  constructor(
    private readonly svc:    CreativeService,
    private readonly images: CreativeImagePipelineService,
    private readonly videos: CreativeVideoPipelineService,
    private readonly mlPub:  CreativeMlPublisherService,
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
      model_name?:       'kling-v1-6-std' | 'kling-v1-6-pro' | 'kling-v2-master'
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
}
