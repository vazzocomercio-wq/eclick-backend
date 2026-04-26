import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import {
  SuppliersService, CreateSupplierDto, UpdateSupplierDto,
  LinkProductDto, UpdateProductLinkDto, AddDocumentDto,
} from './suppliers.service'

@Controller('suppliers')
@UseGuards(SupabaseAuthGuard)
export class SuppliersController {
  constructor(private readonly svc: SuppliersService) {}

  // Extracts organization_id directly from the JWT — same approach used in
  // supabase-auth.guard.ts but with explicit logging so failures are visible.
  private async resolveOrgId(auth: string | undefined): Promise<string> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    const { data, error } = await supabaseAdmin
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user?.id ?? '')
      .single()
    if (error || !data) throw new HttpException('Organização não encontrada', 400)
    return data.organization_id as string
  }

  // ── Suppliers ────────────────────────────────────────────────────────────────

  @Get()
  async getAll(
    @Headers('authorization') auth: string,
    @Query('type')    type?:    string,
    @Query('country') country?: string,
    @Query('active')  active?:  string,
    @Query('q')       q?:       string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getAll(orgId, { type, country, active, q })
  }

  @Get(':id')
  async getById(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getById(orgId, id)
  }

  @Post()
  async create(
    @Headers('authorization') auth: string,
    @Body() dto: CreateSupplierDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.create(orgId, dto)
  }

  @Patch(':id')
  async update(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.update(orgId, id, dto)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.deactivate(orgId, id)
  }

  // ── Products ─────────────────────────────────────────────────────────────────

  @Get(':id/products')
  async getProducts(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getProducts(orgId, id)
  }

  @Post(':id/products')
  async linkProduct(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: LinkProductDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.linkProduct(orgId, id, dto)
  }

  @Patch(':id/products/:productId')
  async updateProductLink(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateProductLinkDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateProductLink(orgId, id, productId, dto)
  }

  @Delete(':id/products/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkProduct(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('productId') productId: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.unlinkProduct(orgId, id, productId)
  }

  // ── Documents ────────────────────────────────────────────────────────────────

  @Post(':id/documents')
  async addDocument(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: AddDocumentDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.addDocument(orgId, id, dto)
  }

  @Delete(':id/documents/:docId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDocument(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('docId') docId: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.removeDocument(orgId, id, docId)
  }
}
