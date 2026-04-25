import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import {
  SuppliersService, CreateSupplierDto, UpdateSupplierDto,
  LinkProductDto, UpdateProductLinkDto, AddDocumentDto,
} from './suppliers.service'

interface AuthUser { id: string; orgId: string | null }

@Controller('suppliers')
@UseGuards(SupabaseAuthGuard)
export class SuppliersController {
  constructor(private readonly svc: SuppliersService) {}

  // ── Suppliers ────────────────────────────────────────────────────────────────

  @Get()
  getAll(
    @ReqUser() user: AuthUser,
    @Query('type')    type?:    string,
    @Query('country') country?: string,
    @Query('active')  active?:  string,
    @Query('q')       q?:       string,
  ) {
    return this.svc.getAll(user.orgId, { type, country, active, q })
  }

  @Get(':id')
  getById(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.getById(user.orgId, id)
  }

  @Post()
  create(@ReqUser() user: AuthUser, @Body() dto: CreateSupplierDto) {
    return this.svc.create(user.orgId, dto)
  }

  @Patch(':id')
  update(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.svc.update(user.orgId, id, dto)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivate(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.deactivate(user.orgId, id)
  }

  // ── Products ─────────────────────────────────────────────────────────────────

  @Get(':id/products')
  getProducts(@ReqUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.getProducts(user.orgId, id)
  }

  @Post(':id/products')
  linkProduct(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: LinkProductDto,
  ) {
    return this.svc.linkProduct(user.orgId, id, dto)
  }

  @Patch(':id/products/:productId')
  updateProductLink(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateProductLinkDto,
  ) {
    return this.svc.updateProductLink(user.orgId, id, productId, dto)
  }

  @Delete(':id/products/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unlinkProduct(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Param('productId') productId: string,
  ) {
    return this.svc.unlinkProduct(user.orgId, id, productId)
  }

  // ── Documents ────────────────────────────────────────────────────────────────

  @Post(':id/documents')
  addDocument(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddDocumentDto,
  ) {
    return this.svc.addDocument(user.orgId, id, dto)
  }

  @Delete(':id/documents/:docId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeDocument(
    @ReqUser() user: AuthUser,
    @Param('id') id: string,
    @Param('docId') docId: string,
  ) {
    return this.svc.removeDocument(user.orgId, id, docId)
  }
}
