import {
  Controller, Get, Post, Body, Query, UseGuards, BadRequestException,
} from '@nestjs/common'
import { AdminSecretGuard } from '../../admin/admin-secret.guard'
import { supabaseAdmin } from '../../../common/supabase'
import { VisitsScannerService } from './visits-scanner.service'
import type { ScanResult } from './dto/scan-result.dto'

interface RunBody {
  orgId:       string
  sellerId?:   number
  periodDays?: number[]
}

/**
 * F11 Fase 2 — Admin endpoints pro visits scanner.
 *
 * Protegido por AdminSecretGuard (header x-admin-secret).
 * Útil pra dev local, trigger pós-deploy ou debug sob demanda.
 *
 * Ordem das rotas importa (path-to-regexp v6 — feedback_path_to_regexp_v6):
 * literais antes de catch-all.
 */
@Controller('admin/visits-scanner')
@UseGuards(AdminSecretGuard)
export class VisitsScannerController {
  constructor(private readonly scanner: VisitsScannerService) {}

  /**
   * POST /admin/visits-scanner/run
   * body: { orgId: string, sellerId?: number, periodDays?: number[] }
   *
   * Executa scan sob demanda. Síncrono — pode demorar minutos.
   */
  @Post('run')
  async run(@Body() body: RunBody): Promise<{ results: ScanResult[] }> {
    if (!body.orgId) throw new BadRequestException('orgId obrigatório')

    const periodDays = body.periodDays && body.periodDays.length > 0
      ? body.periodDays
      : [7]

    if (body.sellerId != null) {
      // 1 seller específico
      const result = await this.scanner.scanSeller(body.orgId, Number(body.sellerId), {
        periodDays,
        rateLimitMs: 1000,
        maxRetries:  3,
        maxItemsPerSeller: 2000,
      })
      return { results: [result] }
    }

    // Todos os sellers da org
    const results = await this.scanner.scanOrganization(body.orgId, { periodDays })
    return { results }
  }

  /**
   * GET /admin/visits-scanner/last-run?orgId=...
   *
   * Resumo do último scan: count por seller + período + max(last_synced_at) + erros.
   */
  @Get('last-run')
  async lastRun(@Query('orgId') orgId?: string) {
    if (!orgId) throw new BadRequestException('orgId obrigatório')

    const { data, error } = await supabaseAdmin
      .from('ml_item_visits_period')
      .select('seller_id, period_days, total_visits, last_synced_at, error_message')
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)

    const rows = (data ?? []) as Array<{
      seller_id:      number
      period_days:    number
      total_visits:   number
      last_synced_at: string
      error_message:  string | null
    }>

    // Agrega por (seller, period_days)
    const grouped = new Map<string, {
      seller_id: number
      period_days: number
      items_synced: number
      errors: number
      last_synced_at: string
    }>()
    for (const r of rows) {
      const key = `${r.seller_id}|${r.period_days}`
      const prev = grouped.get(key) ?? {
        seller_id: r.seller_id, period_days: r.period_days,
        items_synced: 0, errors: 0, last_synced_at: r.last_synced_at,
      }
      prev.items_synced++
      if (r.error_message) prev.errors++
      if (r.last_synced_at > prev.last_synced_at) prev.last_synced_at = r.last_synced_at
      grouped.set(key, prev)
    }
    return { groups: Array.from(grouped.values()) }
  }
}
