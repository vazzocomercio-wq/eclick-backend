import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import {
  OperatingCostsService, CreateOperatingCostDto, UpdateOperatingCostDto,
  OPERATING_COST_CATEGORIES,
} from './operating-costs.service'

/**
 * Cadastro de custos fixos/operacionais + meta de lucro consolidado.
 * Fundação da Central de Resultado (DRE viva). Mesmo padrão de auth do
 * FinanceiroController (resolveOrgId via organization_members).
 */
@Controller('financeiro')
@UseGuards(SupabaseAuthGuard)
export class OperatingCostsController {
  constructor(private readonly svc: OperatingCostsService) {}

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

  // ── Custos fixos/operacionais ───────────────────────────────────────────

  @Get('operating-costs/categories')
  categories() {
    return { categories: OPERATING_COST_CATEGORIES }
  }

  @Get('operating-costs')
  async list(
    @Headers('authorization') auth: string,
    @Query('active') active?: string,
    @Query('category') category?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.list(orgId, {
      active: active === undefined ? undefined : active === 'true',
      category,
    })
  }

  /** Total mensal normalizado (consumido pelo motor de DRE). */
  @Get('operating-costs/monthly-total')
  async monthlyTotal(
    @Headers('authorization') auth: string,
    @Query('month') month?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getMonthlyTotal(orgId, month)
  }

  @Post('operating-costs')
  async create(
    @Headers('authorization') auth: string,
    @Body() dto: CreateOperatingCostDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.create(orgId, dto)
  }

  @Patch('operating-costs/:id')
  async update(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateOperatingCostDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.update(orgId, id, dto)
  }

  @Delete('operating-costs/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    await this.svc.remove(orgId, id)
  }

  // ── Meta de lucro líquido consolidado ────────────────────────────────────

  @Get('result-config')
  async getConfig(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getResultConfig(orgId)
  }

  @Patch('result-config')
  async setConfig(
    @Headers('authorization') auth: string,
    @Body() body: { target_net_margin_pct: number },
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.setResultConfig(orgId, body.target_net_margin_pct)
  }
}
