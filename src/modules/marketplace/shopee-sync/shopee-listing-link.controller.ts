import {
  Controller, Post, Get, Param, Body, UseGuards,
  HttpCode, HttpStatus, BadRequestException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { ShopeeListingLinkService } from './shopee-listing-link.service'
import { ShopeeStockSyncService } from './shopee-stock-sync.service'
import { RequirePermission, RequirePermissionGuard } from '../../rbac'

interface ReqUserPayload { id: string; orgId: string | null }

/** F18 Fase A — Vínculo anúncio Shopee ↔ produto (keystone do nível de edição).
 *
 *  POST /shopee/listings/auto-link        → casa model_sku → products.sku em lote.
 *  GET  /shopee/listings/link-status      → cada anúncio + produto vinculado (UI).
 *  POST /shopee/listings/:itemId/link     → vínculo manual { product_id }.
 *  POST /shopee/listings/:itemId/unlink   → desvincula.
 *
 *  Prefixo coexiste com ShopeeListingsController (GET scores) — Nest resolve por
 *  rota. products.view: consistente com os demais endpoints de sync Shopee. */
@Controller('shopee/listings')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class ShopeeListingLinkController {
  constructor(
    private readonly link:  ShopeeListingLinkService,
    private readonly stock: ShopeeStockSyncService,
  ) {}

  @Post('auto-link')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async autoLink(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.link.autoLinkAll(user.orgId)
  }

  @Get('link-status')
  @RequirePermission('products.view')
  async linkStatus(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.link.getLinkStatus(user.orgId)
  }

  @Post(':itemId/link')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async manualLink(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Body() body: { product_id?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    if (!body?.product_id) throw new BadRequestException('product_id ausente')
    return this.link.manualLink(user.orgId, id, body.product_id)
  }

  @Post(':itemId/unlink')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async unlink(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    return this.link.unlink(user.orgId, id)
  }

  /** Variações (models) do item DIRETO da Shopee + vínculo/sugestão por SKU de
   *  variação do catálogo. Alimenta o painel "Variações" do drawer. */
  @Get(':itemId/models')
  @RequirePermission('products.view')
  async itemModels(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    return this.link.getItemModels(user.orgId, id)
  }

  /** Vincula models do item a produtos/variações do catálogo.
   *  Body: { links: [{ model_id, product_id, product_variation_sku? }] } */
  @Post(':itemId/models/link')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async linkModels(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Body() body: { links?: Array<{ model_id: number; product_id: string; product_variation_sku?: string | null }> },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    if (!Array.isArray(body?.links) || !body.links.length) {
      throw new BadRequestException('links ausente — informe ao menos um model')
    }
    return this.link.linkModels(user.orgId, id, body.links)
  }

  /** Desvincula UM model específico do item. */
  @Post(':itemId/models/:modelId/unlink')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.view')
  async unlinkModel(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Param('modelId') modelId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id  = Number(itemId)
    const mid = Number(modelId)
    if (!Number.isFinite(id))  throw new BadRequestException('itemId inválido')
    if (!Number.isFinite(mid)) throw new BadRequestException('modelId inválido')
    return this.link.unlinkModel(user.orgId, id, mid)
  }

  /** F18 Fase C — AUDITORIA read-only do estoque cru de 1 item (pré-mapeamento). */
  @Get(':itemId/stock-inspect')
  @RequirePermission('products.view')
  async stockInspect(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    return this.stock.inspectStock(user.orgId, id)
  }

  /** F18 Fase C/D — Escreve estoque de 1 anúncio (write-back inline). ⚠️ loja real. */
  @Post(':itemId/stock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async setStock(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Body() body: { quantity?: number; variation_id?: string | null },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    if (body?.quantity == null || !Number.isFinite(Number(body.quantity))) {
      throw new BadRequestException('quantity ausente ou inválido')
    }
    return this.stock.pushStockForItem(user.orgId, id, Number(body.quantity), body.variation_id ?? null)
  }

  /** F18 Fase D — Escreve PREÇO de 1 anúncio (write-back inline). ⚠️ $ real. */
  @Post(':itemId/price')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async setPrice(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    @Body() body: { price?: number; variation_id?: string | null },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    if (body?.price == null || !Number.isFinite(Number(body.price)) || Number(body.price) <= 0) {
      throw new BadRequestException('price ausente ou inválido')
    }
    return this.stock.pushPriceForItem(user.orgId, id, Number(body.price), body.variation_id ?? null)
  }

  /** F18 Fase E — Detalhe editável do item (título/descrição/atributos). */
  @Get(':itemId/detail')
  @RequirePermission('products.view')
  async itemDetail(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    return this.stock.getItemForEdit(user.orgId, id)
  }

  /** F18 Fase C — Propaga o estoque (real+virtual, respeitando mínimo-pausa) de
   *  1 PRODUTO pros seus anúncios Shopee. Manual (ungated). ⚠️ loja real. */
  @Post('product/:productId/push-stock')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async pushProductStock(
    @ReqUser() user: ReqUserPayload,
    @Param('productId') productId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!productId) throw new BadRequestException('productId ausente')
    return this.stock.pushStockForProduct(productId, { bypassGate: true })
  }

  /** F18 Fase E — Edição completa do item (título/descrição/atributos). ⚠️ loja real. */
  @Post(':itemId/item')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('products.update')
  async setItem(
    @ReqUser() user: ReqUserPayload,
    @Param('itemId') itemId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Body() body: { item_name?: string; description?: string; attribute_list?: any[] },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const id = Number(itemId)
    if (!Number.isFinite(id)) throw new BadRequestException('itemId inválido')
    if (body?.item_name == null && body?.description == null && !body?.attribute_list) {
      throw new BadRequestException('nada para atualizar')
    }
    return this.stock.updateItemContent(user.orgId, id, {
      itemName:      body.item_name ?? null,
      description:   body.description ?? null,
      attributeList: body.attribute_list ?? null,
    })
  }
}
