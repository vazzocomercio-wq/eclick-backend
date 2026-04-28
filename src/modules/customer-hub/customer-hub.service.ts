import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { SegmentEvaluatorService, SegmentRule } from './segment-evaluator.service'

export interface CustomerSegment {
  id:              string
  organization_id: string
  name:            string
  description:     string | null
  color:           string
  icon:            string
  rules:           SegmentRule[]
  customer_count:  number
  auto_refresh:    boolean
  last_computed_at: string | null
  created_at:      string
  updated_at:      string
}

@Injectable()
export class CustomerHubService {
  private readonly logger = new Logger(CustomerHubService.name)

  constructor(private readonly evaluator: SegmentEvaluatorService) {}

  // ── Compute (RPC pra função SQL) ────────────────────────────────────────

  /** Chama compute_customer_metrics(p_org_id) → recalcula RFM/ABC/churn/
   * segmento em batch. Retorna stats {updated, duration_ms}. */
  async computeMetrics(orgId: string): Promise<{ updated: number; duration_ms: number }> {
    const t0 = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any).rpc('compute_customer_metrics', { p_org_id: orgId })
    if (error) throw new BadRequestException(`compute failed: ${error.message}`)
    const { count } = await supabaseAdmin
      .from('unified_customers')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .not('rfm_score', 'is', null)
    return { updated: count ?? 0, duration_ms: Date.now() - t0 }
  }

  // ── Overview ────────────────────────────────────────────────────────────

  async getOverview(orgId: string) {
    const { data: rows } = await supabaseAdmin
      .from('unified_customers')
      .select('abc_curve, churn_risk, ltv_score, avg_ticket, segment, last_purchase_at, total_purchases')
      .eq('organization_id', orgId)
    const all = rows ?? []
    const abc = { A: 0, B: 0, C: 0 }
    const churn = { low: 0, medium: 0, high: 0, critical: 0 }
    const segments: Record<string, number> = {}
    let ltvSum = 0, ltvCount = 0
    let ticketSum = 0, ticketCount = 0
    const since90 = Date.now() - 90 * 86_400_000
    let active = 0
    for (const r of all) {
      if (r.abc_curve && abc[r.abc_curve as 'A'|'B'|'C'] !== undefined) abc[r.abc_curve as 'A'|'B'|'C']++
      if (r.churn_risk && churn[r.churn_risk as keyof typeof churn] !== undefined) churn[r.churn_risk as keyof typeof churn]++
      if (r.segment) segments[r.segment as string] = (segments[r.segment as string] ?? 0) + 1
      if (r.ltv_score) { ltvSum += Number(r.ltv_score); ltvCount++ }
      if (r.avg_ticket) { ticketSum += Number(r.avg_ticket); ticketCount++ }
      if (r.last_purchase_at && new Date(r.last_purchase_at).getTime() >= since90) active++
    }
    const topSegment = Object.entries(segments).sort(([,a], [,b]) => b - a)[0]?.[0] ?? null

    return {
      total_customers: all.length,
      abc, churn, segments,
      avg_ltv:    ltvCount    > 0 ? ltvSum    / ltvCount    : 0,
      avg_ticket: ticketCount > 0 ? ticketSum / ticketCount : 0,
      active_customers_90d: active,
      top_segment: topSegment,
    }
  }

  // ── Curva ABC (counts + revenue por curva) ──────────────────────────────

  async getAbc(orgId: string) {
    const { data: rows } = await supabaseAdmin
      .from('unified_customers')
      .select('abc_curve, total_purchases, avg_ticket')
      .eq('organization_id', orgId)
      .not('abc_curve', 'is', null)
    const buckets = {
      A: { count: 0, revenue: 0, avg_ticket: 0 },
      B: { count: 0, revenue: 0, avg_ticket: 0 },
      C: { count: 0, revenue: 0, avg_ticket: 0 },
    }
    let totalRev = 0
    for (const r of rows ?? []) {
      const c = r.abc_curve as 'A'|'B'|'C'
      const buc = buckets[c]
      if (!buc) continue
      buc.count++
      const rev = Number(r.total_purchases ?? 0)
      buc.revenue += rev
      totalRev += rev
    }
    for (const c of ['A','B','C'] as const) {
      const buc = buckets[c]
      buc.avg_ticket = buc.count > 0 ? buc.revenue / buc.count : 0
    }
    return {
      A: { ...buckets.A, pct_revenue: totalRev > 0 ? buckets.A.revenue / totalRev : 0 },
      B: { ...buckets.B, pct_revenue: totalRev > 0 ? buckets.B.revenue / totalRev : 0 },
      C: { ...buckets.C, pct_revenue: totalRev > 0 ? buckets.C.revenue / totalRev : 0 },
      total_revenue: totalRev,
    }
  }

  // ── RFM distribution (histograma 0-10 em buckets de 1) ──────────────────

  async getRfmDistribution(orgId: string) {
    const { data: rows } = await supabaseAdmin
      .from('unified_customers')
      .select('rfm_score, rfm_frequency, rfm_recency_days, rfm_monetary, ltv_score, abc_curve, display_name, id')
      .eq('organization_id', orgId)
      .not('rfm_score', 'is', null)
    const buckets = Array.from({ length: 10 }, (_, i) => ({ bucket: i, label: `${i}-${i+1}`, count: 0 }))
    const scatter: Array<{ id: string; name: string | null; frequency: number; recency: number; monetary: number; score: number }> = []
    for (const r of rows ?? []) {
      const s = Number(r.rfm_score ?? 0)
      const idx = Math.min(9, Math.max(0, Math.floor(s)))
      buckets[idx].count++
      scatter.push({
        id: r.id as string,
        name: (r.display_name as string | null) ?? null,
        frequency: Number(r.rfm_frequency ?? 0),
        recency:   Number(r.rfm_recency_days ?? 0),
        monetary:  Number(r.rfm_monetary ?? 0),
        score:     s,
      })
    }
    return { histogram: buckets, scatter: scatter.slice(0, 1000) }
  }

  // ── Churn risk (counts) ─────────────────────────────────────────────────

  async getChurnRisk(orgId: string) {
    const { data: rows } = await supabaseAdmin
      .from('unified_customers')
      .select('churn_risk')
      .eq('organization_id', orgId)
      .not('churn_risk', 'is', null)
    const out = { low: 0, medium: 0, high: 0, critical: 0 }
    for (const r of rows ?? []) {
      const k = r.churn_risk as keyof typeof out
      if (out[k] !== undefined) out[k]++
    }
    return out
  }

  /** Lista de clientes em alto/crítico risco para campanhas de reativação. */
  async getChurnRiskCustomers(orgId: string, limit = 50) {
    const { data } = await supabaseAdmin
      .from('unified_customers')
      .select('id, display_name, phone, last_purchase_at, rfm_recency_days, ltv_score, avg_ticket, churn_risk')
      .eq('organization_id', orgId)
      .in('churn_risk', ['high', 'critical'])
      .order('ltv_score', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 500))
    return data ?? []
  }

  // ── Top customers ───────────────────────────────────────────────────────

  async getTopCustomers(orgId: string, opts: { limit?: number; sort?: 'ltv' | 'rfm' | 'monetary' }) {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
    const sortCol = opts.sort === 'rfm'      ? 'rfm_score'
                  : opts.sort === 'monetary' ? 'rfm_monetary'
                  : 'ltv_score'
    const { data } = await supabaseAdmin
      .from('unified_customers')
      .select('id, display_name, phone, cpf, abc_curve, ltv_score, rfm_score, rfm_monetary, rfm_frequency, rfm_recency_days, segment, last_purchase_at, avg_ticket')
      .eq('organization_id', orgId)
      .not(sortCol, 'is', null)
      .order(sortCol, { ascending: false })
      .limit(limit)
    return data ?? []
  }

  // ── Segments CRUD ───────────────────────────────────────────────────────

  async listSegments(orgId: string): Promise<CustomerSegment[]> {
    const { data, error } = await supabaseAdmin
      .from('customer_segments')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw new BadRequestException(error.message)
    return (data ?? []) as CustomerSegment[]
  }

  async createSegment(orgId: string, input: Partial<CustomerSegment>): Promise<CustomerSegment> {
    if (!input.name) throw new BadRequestException('name obrigatório')
    const row = {
      organization_id: orgId,
      name:            input.name,
      description:     input.description ?? null,
      color:           input.color ?? '#00E5FF',
      icon:            input.icon  ?? '👥',
      rules:           input.rules ?? [],
      auto_refresh:    input.auto_refresh ?? true,
    }
    const { data, error } = await supabaseAdmin
      .from('customer_segments').insert(row).select().single()
    if (error) throw new BadRequestException(error.message)
    return data as CustomerSegment
  }

  async updateSegment(orgId: string, id: string, patch: Partial<CustomerSegment>): Promise<CustomerSegment> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of ['name','description','color','icon','rules','auto_refresh'] as const) {
      if (patch[k] !== undefined) update[k] = patch[k]
    }
    const { data, error } = await supabaseAdmin
      .from('customer_segments').update(update)
      .eq('id', id).eq('organization_id', orgId)
      .select().single()
    if (error) throw new BadRequestException(error.message)
    if (!data)  throw new NotFoundException('segment não encontrado')
    return data as CustomerSegment
  }

  async deleteSegment(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin
      .from('customer_segments').delete()
      .eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)
    return { ok: true }
  }

  /** Avalia rules + popula customer_segment_members + atualiza customer_count. */
  async computeSegment(orgId: string, id: string): Promise<{ count: number }> {
    const { data: seg } = await supabaseAdmin
      .from('customer_segments').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!seg) throw new NotFoundException('segment não encontrado')
    const ids = await this.evaluator.matchCustomerIds(orgId, (seg.rules ?? []) as SegmentRule[])
    // Limpa membros e re-insere
    await supabaseAdmin.from('customer_segment_members').delete().eq('segment_id', id)
    if (ids.length > 0) {
      const rows = ids.map(cid => ({ segment_id: id, customer_id: cid }))
      // chunk 500 por insert pra evitar payload gigante
      for (let i = 0; i < rows.length; i += 500) {
        const slice = rows.slice(i, i + 500)
        await supabaseAdmin.from('customer_segment_members').insert(slice)
      }
    }
    await supabaseAdmin
      .from('customer_segments')
      .update({ customer_count: ids.length, last_computed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
    return { count: ids.length }
  }

  /** Lista clientes de um segmento (paginado). */
  async listSegmentCustomers(orgId: string, id: string, opts: { limit?: number; offset?: number }) {
    // Sanity: confirma que o segment é da org
    const { data: seg } = await supabaseAdmin
      .from('customer_segments').select('id')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!seg) throw new NotFoundException('segment não encontrado')

    const limit  = Math.min(Math.max(opts.limit  ?? 50, 1), 500)
    const offset = Math.max(opts.offset ?? 0, 0)

    const { data: members, count } = await supabaseAdmin
      .from('customer_segment_members')
      .select('customer_id', { count: 'exact' })
      .eq('segment_id', id)
      .range(offset, offset + limit - 1)
    const customerIds = (members ?? []).map(m => m.customer_id as string)
    if (customerIds.length === 0) return { items: [], total: count ?? 0, limit, offset }

    const { data: customers } = await supabaseAdmin
      .from('unified_customers')
      .select('id, display_name, phone, cpf, abc_curve, ltv_score, segment, last_purchase_at')
      .in('id', customerIds)
    return { items: customers ?? [], total: count ?? 0, limit, offset }
  }

  /** Lista todas as orgs ativas pra cron iterar. Estratégia: distintas em
   * unified_customers (subset suficiente). */
  async listActiveOrgs(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('unified_customers')
      .select('organization_id')
      .not('organization_id', 'is', null)
      .limit(10_000)
    const set = new Set<string>()
    for (const r of data ?? []) set.add(r.organization_id as string)
    return [...set]
  }
}
