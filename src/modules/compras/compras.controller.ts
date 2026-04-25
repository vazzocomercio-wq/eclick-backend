import {
  Controller, Get, Query, UseGuards, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { ComprasService } from './compras.service'

@Controller('compras')
@UseGuards(SupabaseAuthGuard)
export class ComprasController {
  constructor(private readonly svc: ComprasService) {}

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

  // Must be declared before the generic 'inteligencia' route to avoid path conflict
  @Get('inteligencia/summary')
  async getSummary(@Headers('authorization') auth: string) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getSummary(orgId)
  }

  @Get('inteligencia')
  async getInteligencia(
    @Headers('authorization') auth: string,
    @Query('periodo')     periodo?:     string,
    @Query('supply_type') supply_type?: string,
    @Query('abc_class')   abc_class?:   string,
    @Query('min_score')   min_score?:   string,
    @Query('q')           q?:           string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getInteligencia(orgId, {
      periodo:    periodo    ? Number(periodo)    : 30,
      supply_type,
      abc_class,
      min_score:  min_score  ? Number(min_score)  : undefined,
      q,
    })
  }
}
