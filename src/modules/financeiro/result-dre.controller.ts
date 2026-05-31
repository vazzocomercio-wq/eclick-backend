import {
  Controller, Get, Query, UseGuards, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { ResultDreService } from './result-dre.service'

/** DRE viva / Central de Resultado — consolidado + por SKU (mês). */
@Controller('financeiro/result')
@UseGuards(SupabaseAuthGuard)
export class ResultDreController {
  constructor(private readonly svc: ResultDreService) {}

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

  /** DRE consolidada do mês: receita→MC→ADS(TACOS)→fixo→líquido + meta + envelope. */
  @Get('consolidated')
  async consolidated(
    @Headers('authorization') auth: string,
    @Query('month') month?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getConsolidated(orgId, month)
  }

  /** Lucro líquido por SKU/anúncio (pior primeiro): receita, MC, ADS, fixo rateado, líquido. */
  @Get('by-product')
  async byProduct(
    @Headers('authorization') auth: string,
    @Query('month') month?: string,
    @Query('limit') limit?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    return this.svc.getByProduct(orgId, month, limit ? Math.min(Number(limit) || 200, 1000) : 200)
  }
}
