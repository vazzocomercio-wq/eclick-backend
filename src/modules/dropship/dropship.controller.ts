import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import {
  DropshipService,
  CreateDropshipPartnerDto, UpdateDropshipPartnerDto,
  CreateAccountSupplierDto, UpdateAccountSupplierDto,
} from './dropship.service'

@Controller('dropship')
@UseGuards(SupabaseAuthGuard)
export class DropshipController {
  constructor(private readonly svc: DropshipService) {}

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

  // ── Partners ─────────────────────────────────────────────────────────────

  @Get('partners')
  async listPartners(
    @Headers('authorization') auth: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listPartners(orgId, { status, q })
  }

  @Get('partners/:id')
  async getPartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getPartner(orgId, id)
  }

  @Post('partners')
  async createPartner(
    @Headers('authorization') auth: string,
    @Body() dto: CreateDropshipPartnerDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createPartner(orgId, dto)
  }

  @Patch('partners/:id')
  async updatePartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateDropshipPartnerDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updatePartner(orgId, id, dto)
  }

  @Delete('partners/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archivePartner(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.archivePartner(orgId, id)
  }

  // ── Account-Suppliers ────────────────────────────────────────────────────

  @Get('account-suppliers')
  async listAccountSuppliers(
    @Headers('authorization') auth: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('marketplace') marketplace?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listAccountSuppliers(orgId, { supplier_id, marketplace })
  }

  @Post('account-suppliers')
  async createAccountSupplier(
    @Headers('authorization') auth: string,
    @Body() dto: CreateAccountSupplierDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.createAccountSupplier(orgId, dto)
  }

  @Patch('account-suppliers/:id')
  async updateAccountSupplier(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateAccountSupplierDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updateAccountSupplier(orgId, id, dto)
  }

  @Delete('account-suppliers/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkAccountSupplier(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.unlinkAccountSupplier(orgId, id)
  }
}
