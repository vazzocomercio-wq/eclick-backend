import { Controller, Get, Patch, Post, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'
import { CustomerIdentityService } from './customer-identity.service'

@Controller('customers')
@UseGuards(SupabaseAuthGuard)
export class CustomersController {
  constructor(private readonly svc: CustomerIdentityService) {}

  @Get()
  list(
    @Query('search')            search?:           string,
    @Query('channel')           channel?:          string,
    @Query('limit')             limit?:            string,
    @Query('page')              page?:             string,
    @Query('per_page')          perPage?:          string,
    @Query('sort_by')           sortBy?:           string,
    @Query('sort_dir')          sortDir?:          string,
    @Query('enrichment_status') enrichmentStatus?: string,
    @Query('has_cpf')           hasCpf?:           string,
    @Query('has_phone')         hasPhone?:         string,
    @Query('has_whatsapp')      hasWa?:            string,
    @Query('has_email')         hasEmail?:         string,
    @Query('is_vip')            isVip?:            string,
    @Query('is_blocked')        isBlocked?:        string,
  ) {
    const flag = (v?: string) => v === '1' || v === 'true'
    return this.svc.list({
      search, channel,
      limit:    limit    ? Number(limit)    : undefined,
      page:     page     ? Number(page)     : undefined,
      per_page: perPage  ? Number(perPage)  : undefined,
      sort_by:  sortBy,
      sort_dir: sortDir === 'asc' ? 'asc' : sortDir === 'desc' ? 'desc' : undefined,
      enrichment_status: enrichmentStatus,
      has_cpf:      flag(hasCpf),
      has_phone:    flag(hasPhone),
      has_whatsapp: flag(hasWa),
      has_email:    flag(hasEmail),
      is_vip:       flag(isVip),
      is_blocked:   flag(isBlocked),
    })
  }

  /** GET /customers/stats — agregados COUNT FILTER do banco inteiro pra
   * a org. NÃO é filtrado por paginação. Frontend chama no carregamento
   * da página de clientes pra alimentar contadores do painel lateral. */
  @Get('stats')
  stats(@ReqUser() user: { id: string; orgId: string | null }) {
    return this.svc.getStats(user.orgId ?? '')
  }

  // ── Bulk actions (chamados pela barra em /dashboard/crm/clientes) ──────
  // IMPORTANTE: rotas com path literal precisam vir ANTES de :id pra não
  // serem interpretadas como id="bulk"/"export"/"merge".

  /** PATCH /customers/bulk — VIP / Bloquear em N clientes via tags.
   * Body: { customer_ids, is_vip?, is_blocked? }. Retorna { updated, total }. */
  @Patch('bulk')
  async bulkUpdate(
    @ReqUser() user: { id: string; orgId: string | null },
    @Body() body: { customer_ids?: string[]; is_vip?: boolean; is_blocked?: boolean },
  ) {
    const ids = Array.isArray(body?.customer_ids) ? body.customer_ids : []
    const r = await this.svc.bulkUpdateFlags(user.orgId ?? '', ids, {
      is_vip:     typeof body?.is_vip     === 'boolean' ? body.is_vip     : undefined,
      is_blocked: typeof body?.is_blocked === 'boolean' ? body.is_blocked : undefined,
    })
    return { ...r, total: ids.length }
  }

  /** GET /customers/export?ids=id1,id2 — CSV download. Sem ids exporta
   * a org inteira (cap 50k). Headers Content-Type/Content-Disposition. */
  @Get('export')
  async exportCsv(
    @ReqUser() user: { id: string; orgId: string | null },
    @Res() res: Response,
    @Query('ids') ids?: string,
  ) {
    const idList = ids ? ids.split(',').map(s => s.trim()).filter(Boolean) : undefined
    const csv = await this.svc.exportCsv(user.orgId ?? '', idList)
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type',        'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="clientes-${stamp}.csv"`)
    res.send(csv)
  }

  @Post('merge')
  merge(@Body() body: { target_id?: string; source_id?: string; keep_id?: string; discard_id?: string }) {
    // Aceita keep_id/discard_id (do bulk action de /clientes) e o legado
    // target_id/source_id. keep == target (fica), discard == source (some).
    const target = body.target_id ?? body.keep_id ?? ''
    const source = body.source_id ?? body.discard_id ?? ''
    return this.svc.mergeProfiles(target, source)
  }

  /** POST /customers/segments/bulk-add — STUB. Implementação real em
   * customer-hub (segments evaluator). Retorna { success, message }. */
  @Post('segments/bulk-add')
  segmentsBulkAdd(@Body() body: { customer_ids?: string[]; segment_id?: string }) {
    const n = Array.isArray(body?.customer_ids) ? body.customer_ids.length : 0
    return { success: true, message: 'Em breve', total: n, segment_id: body?.segment_id ?? null }
  }

  // ── Single-customer routes (depois das literais) ───────────────────────

  @Get(':id')
  get(@Param('id') id: string) {
    return this.svc.get(id)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: { display_name?: string; tags?: string[]; notes?: string; email?: string; phone?: string },
  ) {
    return this.svc.update(id, body)
  }

  @Post(':id/tags/:tag')
  addTag(@Param('id') id: string, @Param('tag') tag: string) {
    return this.svc.setTag(id, tag, true)
  }

  @Delete(':id/tags/:tag')
  removeTag(@Param('id') id: string, @Param('tag') tag: string) {
    return this.svc.setTag(id, tag, false)
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id)
  }
}
