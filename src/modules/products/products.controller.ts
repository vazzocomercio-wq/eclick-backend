import { Controller, Get, Put, Patch, Delete, Post, Param, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { ProductsService, UpdateProductCostsDto, CreateVinculoDto, CreateStockMovementDto, UpdateStockDto } from './products.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('products')
@UseGuards(SupabaseAuthGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  // GET /products
  @Get()
  getAll(@ReqUser() user: ReqUserPayload) {
    return this.products.getAll(user.orgId)
  }

  // GET /products/linked-listings  — must be before :id to avoid param capture
  @Get('linked-listings')
  getLinkedListingIds() {
    return this.products.getLinkedListingIds()
  }

  // POST /products/vinculos
  @Post('vinculos')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createVinculo(@Body() body: any) {
    console.log('[vinculos.create] body recebido:', JSON.stringify(body))
    try {
      const result = await this.products.createVinculo(body)
      console.log('[vinculos.create] sucesso:', result)
      return result
    } catch (e: unknown) {
      const err = e as Error
      console.error('[vinculos.create] ERRO:', err.message)
      console.error('[vinculos.create] STACK:', err.stack)
      throw e
    }
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
