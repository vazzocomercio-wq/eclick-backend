import { Controller, Get, Put, Patch, Delete, Post, Param, Body, Query, UseGuards, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common'
import { ProductsService, UpdateProductCostsDto, CreateVinculoDto, CreateStockMovementDto, UpdateStockDto } from './products.service'
import { CreativeService } from '../creative/creative.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('products')
@UseGuards(SupabaseAuthGuard)
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly creative: CreativeService,
  ) {}

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
  ) {
    const paginated = page || perPage || search || quickFilter || sortBy
    if (!paginated) return this.products.getAll(user.orgId)
    return this.products.listPaginated(user.orgId, {
      page:         page ? Number(page) : undefined,
      per_page:     perPage ? Number(perPage) : undefined,
      search,
      quick_filter: quickFilter,
      sort_by:      sortBy,
      sort_dir:     sortDir === 'asc' ? 'asc' : sortDir === 'desc' ? 'desc' : undefined,
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

  // POST /products/vinculos
  @Post('vinculos')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createVinculo(@Body() body: any) {
    return this.products.createVinculo(body)
  }

  // DELETE /products/vinculos/:id
  @Delete('vinculos/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteVinculo(@Param('id') id: string) {
    return this.products.deleteVinculo(id)
  }

  // POST /products/stock/movement
  @Post('stock/movement')
  createStockMovement(@ReqUser() user: ReqUserPayload, @Body() dto: CreateStockMovementDto) {
    return this.products.createStockMovement(dto, user.id)
  }

  // PATCH /products/stock/:id
  @Patch('stock/:id')
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
  updateFull(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.products.updateFull(id, body)
  }

  // PATCH /products/:id  (costs only)
  @Patch(':id')
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
  deleteProduct(@Param('id') id: string) {
    return this.products.deleteProduct(id)
  }

  // POST /products/bulk-delete  { ids: string[] }
  @Post('bulk-delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  bulkDelete(@Body() body: { ids: string[] }) {
    return this.products.deleteMany(body.ids)
  }
}
