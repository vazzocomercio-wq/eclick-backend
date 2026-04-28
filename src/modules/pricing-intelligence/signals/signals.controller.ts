import {
  Controller, Get, Post, Body, Param, Query, UseGuards, HttpCode, HttpStatus,
  BadRequestException, NotFoundException,
} from '@nestjs/common'
import { SupabaseAuthGuard } from '../../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../../common/decorators/user.decorator'
import { supabaseAdmin } from '../../../common/supabase'
import { SignalScannerService } from './signal-scanner.service'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('pricing/signals')
@UseGuards(SupabaseAuthGuard)
export class SignalsController {
  constructor(private readonly scanner: SignalScannerService) {}

  /** GET /pricing/signals?status=&signal_type=&severity=&product_id=
   *                       &channel=&limit=&offset= */
  @Get()
  async list(
    @ReqUser() user: ReqUserPayload,
    @Query('status')      status?:     string,
    @Query('signal_type') signalType?: string,
    @Query('severity')    severity?:   string,
    @Query('product_id')  productId?:  string,
    @Query('channel')     channel?:    string,
    @Query('limit')       limitStr?:   string,
    @Query('offset')      offsetStr?:  string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const limit  = Math.min(Math.max(Number(limitStr ?? 50), 1), 500)
    const offset = Math.max(Number(offsetStr ?? 0), 0)

    let q = supabaseAdmin.from('pricing_signals')
      .select('*', { count: 'exact' })
      .eq('organization_id', user.orgId)
    if (status)     q = q.eq('status', status);     else q = q.eq('status', 'active')
    if (signalType) q = q.eq('signal_type', signalType)
    if (severity)   q = q.eq('severity', severity)
    if (productId)  q = q.eq('product_id', productId)
    if (channel)    q = q.eq('channel', channel)
    q = q.order('severity', { ascending: false })
         .order('created_at', { ascending: false })
         .range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new BadRequestException(error.message)
    return { signals: data ?? [], total: count ?? 0, limit, offset }
  }

  /** GET /pricing/signals/summary — counts por severity e signal_type. */
  @Get('summary')
  async summary(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const { data } = await supabaseAdmin
      .from('pricing_signals').select('severity, signal_type')
      .eq('organization_id', user.orgId).eq('status', 'active')
    const rows = (data ?? []) as Array<{ severity: string; signal_type: string }>
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>
    const byType: Record<string, number> = {}
    for (const r of rows) {
      bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1
      byType[r.signal_type]  = (byType[r.signal_type]  ?? 0) + 1
    }
    return { total: rows.length, by_severity: bySeverity, by_type: byType }
  }

  @Get(':id')
  async get(@ReqUser() user: ReqUserPayload, @Param('id') id: string) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    const { data } = await supabaseAdmin
      .from('pricing_signals').select('*')
      .eq('id', id).eq('organization_id', user.orgId).maybeSingle()
    if (!data) throw new NotFoundException('signal não encontrado')
    return data
  }

  /** POST /pricing/signals/:id/action
   *   { action: 'approve'|'dismiss'|'snooze', snooze_hours?, note? } */
  @Post(':id/action')
  @HttpCode(HttpStatus.OK)
  async action(
    @ReqUser() user: ReqUserPayload,
    @Param('id') id: string,
    @Body() body: { action: 'approve' | 'dismiss' | 'snooze'; snooze_hours?: number; note?: string },
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    if (!['approve','dismiss','snooze'].includes(body?.action)) throw new BadRequestException('action inválido')

    const update: Record<string, unknown> = {
      actioned_at:  new Date().toISOString(),
      actioned_by:  user.id,
      action_taken: body.action + (body.note ? ` (${body.note})` : ''),
      updated_at:   new Date().toISOString(),
    }
    if (body.action === 'approve' || body.action === 'dismiss') {
      update.status = 'actioned'
    }
    if (body.action === 'snooze') {
      const hours = Math.max(1, Math.min(72, body.snooze_hours ?? 24))
      update.expires_at = new Date(Date.now() + hours * 3_600_000).toISOString()
    }

    const { data, error } = await supabaseAdmin
      .from('pricing_signals').update(update)
      .eq('id', id).eq('organization_id', user.orgId).select().single()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException('signal não encontrado')
    return data
  }

  /** POST /pricing/signals/scan — scan manual da org inteira. */
  @Post('scan')
  @HttpCode(HttpStatus.OK)
  scan(@ReqUser() user: ReqUserPayload) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.scanner.scanOrg(user.orgId)
  }

  /** POST /pricing/signals/scan-product/:product_id — scan ad-hoc. */
  @Post('scan-product/:product_id')
  @HttpCode(HttpStatus.OK)
  scanProduct(
    @ReqUser() user: ReqUserPayload,
    @Param('product_id') productId: string,
  ) {
    if (!user.orgId) throw new BadRequestException('orgId ausente')
    return this.scanner.scanProduct(user.orgId, productId)
  }
}
