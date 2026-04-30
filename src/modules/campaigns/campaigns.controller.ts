import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CampaignsService, Campaign, CampaignSegmentType } from './campaigns.service'
import type { ImageFormat } from '../ai/types'

interface ReqUserPayload { id: string; orgId: string | null }

/** Sprint F5-2 / Batch 1.5 — route ordering reorganizado. NestJS resolve
 * rotas pela ordem de declaração da classe; rotas com paths estáticos
 * (`products/search`, `import-from-url`, etc) DEVEM vir antes de rotas
 * parametrizadas com `:id` (ex: `@Get(':id')`) pra evitar shadowing.
 *
 * `assets/:id/approve` é seguro mesmo declarado depois porque tem prefixo
 * estático `assets/`. */
@Controller('campaigns')
@UseGuards(SupabaseAuthGuard)
export class CampaignsController {
  constructor(private readonly svc: CampaignsService) {}

  // ════════════════════════════════════════════════════════════════════════
  // ROTAS COM PATH ESTÁTICO (precisam vir antes de :id)
  // ════════════════════════════════════════════════════════════════════════

  // ── F5-2: Step 1 wizard ─────────────────────────────────────────────────

  @Get('products/search')
  async searchProducts(
    @ReqUser() user: ReqUserPayload,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const results = await this.svc.searchProducts(user.orgId, q ?? '', limit ? Number(limit) : undefined)
    return { results }
  }

  @Post('import-from-url')
  importFromUrl(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { url: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.importFromUrl(user.orgId, body?.url ?? '')
  }

  @Get('listing-images')
  listingImages(
    @ReqUser() user: ReqUserPayload,
    @Query('listing_id') listingId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getListingImages(user.orgId, listingId ?? '')
  }

  @Post('generate-card')
  generateCard(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      campaign_id?:       string | null
      product:            { title: string; price?: number; sale_price?: number }
      source:             'product_image' | 'listing_image' | 'ai_only'
      source_image_url?:  string
      prompt?:            string
      formats:            ImageFormat[]
      n:                  number
      providerOverride?:  { provider: 'anthropic' | 'openai'; model: string }
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateCard(user.orgId, body)
  }

  @Post('refine-image')
  refineImage(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { asset_id: string; refinement_prompt: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.refineImage(user.orgId, body)
  }

  @Post('canva/open')
  openInCanva(
    @ReqUser() user: ReqUserPayload,
    @Body() body: { asset_id: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.openInCanva(user.orgId, body)
  }

  // assets/:id tem prefixo estático — safe vs `:id` puro
  @Post('assets/:id/approve')
  approveAsset(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { campaign_id?: string | null },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.approveAsset(user.orgId, id, body?.campaign_id ?? null)
  }

  // ── F5-1: audience preview + AI text + cron tick ────────────────────────

  @Post('estimate-reach')
  estimateReach(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      segment_type:    CampaignSegmentType
      segment_filters?: Record<string, unknown> | null
      customer_ids?:    string[]
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.estimateReach(user.orgId, body)
  }

  @Post('generate-content')
  generateContent(
    @ReqUser() user: ReqUserPayload,
    @Body() body: {
      objective:        string
      product_name?:    string
      tone?:            'amigavel' | 'profissional' | 'urgente'
      ab_variants?:     boolean
      providerOverride?: { provider: 'anthropic' | 'openai'; model: string }
    },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.generateContent(user.orgId, body)
  }

  @Post('process-now')
  processNow(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.runOnce()
  }

  // ════════════════════════════════════════════════════════════════════════
  // ROTAS GENÉRICAS (devem vir DEPOIS de qualquer path estático)
  // ════════════════════════════════════════════════════════════════════════

  @Get()
  list(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.list(user.orgId)
  }

  @Post()
  create(@ReqUser() user: ReqUserPayload, @Body() body: Partial<Campaign>) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.create(user.orgId, user.id, body)
  }

  @Get(':id')
  getOne(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.getOne(user.orgId, id)
  }

  @Patch(':id')
  update(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: Partial<Campaign>,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.update(user.orgId, id, body)
  }

  @Delete(':id')
  remove(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.remove(user.orgId, id)
  }

  @Post(':id/launch')
  launch(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.launch(user.orgId, id)
  }

  @Post(':id/pause')
  pause(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.pause(user.orgId, id)
  }

  @Post(':id/resume')
  resume(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.resume(user.orgId, id)
  }

  @Get(':id/targets')
  listTargets(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Query('status')  status?: string,
    @Query('variant') variant?: string,
    @Query('limit')   limit?: string,
    @Query('offset')  offset?: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.svc.listTargets(user.orgId, id, {
      status,
      variant,
      limit:  limit  ? Number(limit)  : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }
}
