import {
  Controller, Get, Post, Patch, Delete, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import {
  ShippingRatesService, CreateShippingRateDto, UpdateShippingRateDto,
  SHIPPING_LOGISTIC_TYPES,
} from './shipping-rates.service'

/**
 * Cadastro de tarifas de frete pagas POR FORA (Flex etc). Mesmo padrão de auth
 * do FinanceiroController/OperatingCostsController (resolveOrgId via
 * organization_members → multi-tenant).
 */
@Controller('financeiro')
@UseGuards(SupabaseAuthGuard)
export class ShippingRatesController {
  constructor(private readonly svc: ShippingRatesService) {}

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

  @Get('shipping-rates/logistic-types')
  logisticTypes() {
    return { logistic_types: SHIPPING_LOGISTIC_TYPES }
  }

  @Get('shipping-rates')
  async list(
    @Headers('authorization') auth: string,
    @Query('platform') platform?: string,
    @Query('logistic_type') logisticType?: string,
    @Query('active') active?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.list(orgId, {
      platform,
      logistic_type: logisticType,
      active: active === undefined ? undefined : active === 'true',
    })
  }

  @Post('shipping-rates')
  async create(
    @Headers('authorization') auth: string,
    @Body() dto: CreateShippingRateDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.create(orgId, dto)
  }

  @Patch('shipping-rates/:id')
  async update(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() dto: UpdateShippingRateDto,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.update(orgId, id, dto)
  }

  @Delete('shipping-rates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    await this.svc.remove(orgId, id)
  }
}
