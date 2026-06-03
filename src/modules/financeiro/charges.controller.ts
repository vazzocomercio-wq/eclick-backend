import {
  Controller, Get, Post, Body, Query, UseGuards, Headers, HttpException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { supabaseAdmin } from '../../common/supabase'
import { MlBillingIngestService } from './ml-billing-ingest.service'

/**
 * Custos reais por plataforma (platform_charges). Ingestão on-demand da fatura
 * ML + leitura do resumo por categoria/mês. Mesmo padrão de auth do módulo.
 */
@Controller('financeiro')
@UseGuards(SupabaseAuthGuard)
export class ChargesController {
  constructor(private readonly mlBilling: MlBillingIngestService) {}

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

  /** Backfill on-demand: ingere 1 período (?period=YYYY-MM-01) ou os 2 mais
   *  recentes. Dispara em BACKGROUND (fire-and-forget) — a fatura tem milhares
   *  de linhas + rate-limit, então roda além do timeout do proxy. Acompanhe via
   *  GET /financeiro/charges/summary. */
  @Post('charges/ingest-ml')
  async ingestMl(
    @Headers('authorization') auth: string,
    @Body() body: { period?: string; recent?: number } = {},
  ) {
    const orgId = await this.resolveOrgId(auth)
    if (body.period) {
      void this.mlBilling.ingestPeriod(orgId, body.period)
        .catch((e) => { /* logado no service */ void e })
      return { started: true, period: body.period }
    }
    void this.mlBilling.ingestRecent(orgId, body.recent ?? 2)
      .catch((e) => { void e })
    return { started: true, recent: body.recent ?? 2 }
  }

  /** Resumo dos custos reais por categoria, no mês calendário (charge_date). */
  @Get('charges/summary')
  async summary(
    @Headers('authorization') auth: string,
    @Query('month') month?: string,        // 'YYYY-MM' (default mês atual)
    @Query('platform') platform?: string,
  ) {
    const orgId = await this.resolveOrgId(auth)
    const ym = month ?? new Date().toISOString().slice(0, 7)
    const from = `${ym}-01`
    const to = endOfMonth(ym)

    let q = supabaseAdmin
      .from('platform_charges')
      .select('platform, charge_category, detail_type, amount')
      .eq('organization_id', orgId)
      .gte('charge_date', from)
      .lte('charge_date', to)
    if (platform) q = q.eq('platform', platform)
    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)

    // net por categoria (charge − credit) e por plataforma
    const byCat: Record<string, number> = {}
    const byPlatform: Record<string, number> = {}
    let net = 0
    for (const r of (data ?? []) as Array<{ platform: string; charge_category: string; detail_type: string; amount: number }>) {
      const signed = r.detail_type === 'credit' ? -Number(r.amount) : Number(r.amount)
      byCat[r.charge_category] = Math.round(((byCat[r.charge_category] ?? 0) + signed) * 100) / 100
      byPlatform[r.platform] = Math.round(((byPlatform[r.platform] ?? 0) + signed) * 100) / 100
      net += signed
    }
    return {
      month: ym,
      net_total: Math.round(net * 100) / 100,
      by_category: byCat,
      by_platform: byPlatform,
      lines: (data ?? []).length,
    }
  }
}

function endOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${ym}-${String(last).padStart(2, '0')}`
}
