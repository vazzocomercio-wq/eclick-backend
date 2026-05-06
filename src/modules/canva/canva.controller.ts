import {
  Controller, Get, Post, Delete, Param, Query, Body, UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CanvaService, MarketplaceKey, ExportFormat } from './canva.service'

interface ReqUserPayload { id: string; orgId: string | null }

/** Sprint F5-2 / Batch 2.1 — Canva designs/exports/assets controller.
 *
 * Rotas OAuth (/canva/oauth/*) ficam em CanvaOauthController.
 * As rotas estáticas vêm antes das com :param pra evitar bugs de roteamento. */
@Controller('canva')
@UseGuards(SupabaseAuthGuard)
export class CanvaController {
  constructor(private readonly canva: CanvaService) {}

  // ── Static routes ──────────────────────────────────────────────────────

  /** GET /canva/marketplace-dims — lista os marketplaces + dimensões. Frontend
   * usa pra renderizar o select "Onde vai usar?". */
  @Get('marketplace-dims')
  marketplaceDims() {
    return { items: this.canva.listMarketplaceDims() }
  }

  // ── Designs do seller (Canva API) ──────────────────────────────────────

  @Get('designs')
  async listDesigns(
    @ReqUser() u: ReqUserPayload,
    @Query('query') query?: string,
    @Query('continuation') continuation?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.canva.listDesigns(u.orgId, { query, continuation })
  }

  @Get('designs/:id')
  async getDesign(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.canva.getDesign(u.orgId, id)
  }

  @Get('designs/:id/pages')
  async getDesignPages(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return { items: await this.canva.getDesignPages(u.orgId, id) }
  }

  // ── Export ─────────────────────────────────────────────────────────────

  /** POST /canva/export — exporta um design + mirror pro Storage + INSERT canva_assets.
   * Demora 5-15s tipicamente. */
  @Post('export')
  async export(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      designId: string
      format: ExportFormat
      productId?: string
      campaignId?: string
      marketplace?: MarketplaceKey
      name?: string
    },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.designId) throw new BadRequestException('designId obrigatório')
    if (!body?.format) throw new BadRequestException('format obrigatório (png/jpg/pdf)')
    return this.canva.exportDesign(u.orgId, u.id, body)
  }

  // ── Generic upload + open (E3b — usado pelo modulo Creative) ───────────
  /** POST /canva/upload-and-open — generico, nao depende de tabela products.
   *  Recebe image_url + marketplace + title opcional, retorna edit_url. */
  @Post('upload-and-open')
  async uploadAndOpen(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { image_url: string; marketplace: MarketplaceKey; title?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.image_url)   throw new BadRequestException('image_url obrigatório')
    if (!body?.marketplace) throw new BadRequestException('marketplace obrigatório')
    return this.canva.uploadAndOpenForCreative(u.orgId, {
      imageUrl:    body.image_url,
      marketplace: body.marketplace,
      title:       body.title,
    })
  }

  // ── Criar capa de produto (sobe imagem + abre editor Canva) ────────────

  @Post('product-image/:productId')
  async createProductImage(
    @ReqUser() u: ReqUserPayload,
    @Param('productId') productId: string,
    @Body() body: { marketplace: MarketplaceKey; sourceImageUrl?: string },
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    if (!body?.marketplace) throw new BadRequestException('marketplace obrigatório')
    return this.canva.createProductImageDesign(u.orgId, productId, body)
  }

  // ── Galeria de assets exportados ───────────────────────────────────────

  @Get('assets')
  async listAssets(
    @ReqUser() u: ReqUserPayload,
    @Query('product_id') productId?: string,
    @Query('campaign_id') campaignId?: string,
    @Query('marketplace') marketplace?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.canva.listAssets(u.orgId, {
      productId,
      campaignId,
      marketplace,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    })
  }

  @Get('assets/:id')
  async getAsset(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.canva.getAsset(u.orgId, id)
  }

  @Delete('assets/:id')
  async deleteAsset(
    @ReqUser() u: ReqUserPayload,
    @Param('id') id: string,
  ) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    await this.canva.deleteAsset(u.orgId, id)
    return { ok: true }
  }

  // ── Disconnect ─────────────────────────────────────────────────────────

  @Delete('disconnect')
  async disconnect(@ReqUser() u: ReqUserPayload) {
    if (!u.orgId) throw new BadRequestException('orgId ausente')
    return this.canva.disconnect(u.orgId)
  }
}
