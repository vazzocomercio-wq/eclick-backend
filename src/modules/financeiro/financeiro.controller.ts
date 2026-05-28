import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import {
  FinanceiroService, CreatePayableDto, UpdatePayableDto, MarkPaidDto,
} from './financeiro.service'
import { RequirePermission, RequirePermissionGuard } from '../rbac'

@Controller('financeiro')
@UseGuards(SupabaseAuthGuard, RequirePermissionGuard)
export class FinanceiroController {
  constructor(private readonly svc: FinanceiroService) {}

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

  private async resolveUserId(auth: string | undefined): Promise<string | null> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : auth
    const { data: { user } } = await supabaseAdmin.auth.getUser(token ?? '')
    return user?.id ?? null
  }

  // ── Payables ───────────────────────────────────────────────────────────────

  @Get('payables')
  @RequirePermission('financeiro.view')
  async list(
    @Headers('authorization') auth: string,
    @Query('status') status?: string,
    @Query('source_type') source_type?: string,
    @Query('supplier_id') supplier_id?: string,
    @Query('due_from') due_from?: string,
    @Query('due_to') due_to?: string,
    @Query('q') q?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.listPayables(orgId, { status, source_type, supplier_id, due_from, due_to, q })
  }

  @Get('payables/summary')
  @RequirePermission('financeiro.view')
  async summary(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getSummary(orgId)
  }

  @Get('payables/:id')
  @RequirePermission('financeiro.view')
  async get(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getPayable(orgId, id)
  }

  @Post('payables')
  @RequirePermission('financeiro.reconcile')
  async create(
    @Headers('authorization') auth: string,
    @Body() dto: CreatePayableDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const userId = await this.resolveUserId(auth)
    return this.svc.createPayable(orgId, userId, dto)
  }

  @Patch('payables/:id')
  @RequirePermission('financeiro.reconcile')
  async update(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdatePayableDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.updatePayable(orgId, id, dto)
  }

  @Post('payables/:id/pay')
  @RequirePermission('financeiro.reconcile')
  async pay(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: MarkPaidDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.markPaid(orgId, id, dto)
  }

  @Delete('payables/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('financeiro.reconcile')
  async cancel(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.cancelPayable(orgId, id, body.reason)
  }
}
