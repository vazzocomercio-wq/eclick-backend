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
import type { Marketplace } from './creative.marketplace-rules'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('creative')
@UseGuards(SupabaseAuthGuard)
export class CreativeController {
  private readonly logger = new Logger(CreativeController.name)

  constructor(private readonly svc: CreativeService) {}

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
  ) {
    return this.svc.listProducts(this.orgOrThrow(u), {
      status,
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

  // ── Briefings ────────────────────────────────────────────────────────────

  @Post('products/:id/briefings')
  createBriefing(@ReqUser() u: ReqUserPayload, @Param('id') id: string, @Body() body: CreateBriefingDto) {
    return this.svc.createBriefing(this.orgOrThrow(u), id, body)
  }

  @Get('products/:id/briefings')
  listBriefings(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.svc.listBriefings(this.orgOrThrow(u), id)
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
}
