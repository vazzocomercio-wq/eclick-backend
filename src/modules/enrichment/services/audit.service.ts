import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { maskIdentifier } from './hash.util'

export interface AuditEntry {
  organization_id:  string
  user_id?:         string | null
  query_type:       string
  query_value:      string                 // raw — masked here before persistence
  trigger_source:   'manual' | 'auto' | 'batch'
  provider_attempts: Array<{ provider: string; status: string; error?: string; duration_ms?: number }>
  final_provider?:  string | null
  final_status:    'success' | 'partial' | 'failed' | 'cached' | 'rate_limited' | 'no_credit'
  duration_ms?:    number
  cost_cents?:     number
  cache_hit?:      boolean
  customer_id?:    string | null
  order_id?:       string | null
  consent_at?:     string | null
  consent_source?: string | null
}

@Injectable()
export class EnrichmentAuditService {
  private readonly logger = new Logger(EnrichmentAuditService.name)

  async log(entry: AuditEntry): Promise<void> {
    try {
      await supabaseAdmin.from('enrichment_log').insert({
        organization_id:    entry.organization_id,
        user_id:            entry.user_id ?? null,
        query_type:         entry.query_type,
        query_value_masked: maskIdentifier(entry.query_type, entry.query_value),
        trigger_source:     entry.trigger_source,
        provider_attempts:  entry.provider_attempts,
        final_provider:     entry.final_provider ?? null,
        final_status:       entry.final_status,
        duration_ms:        entry.duration_ms ?? 0,
        cost_cents:         entry.cost_cents ?? 0,
        cache_hit:          entry.cache_hit ?? false,
        customer_id:        entry.customer_id ?? null,
        order_id:           entry.order_id ?? null,
        consent_at:         entry.consent_at ?? null,
        consent_source:     entry.consent_source ?? null,
      })
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.audit] ${err?.message}`)
    }
  }

  async list(orgId: string, filters: { customer_id?: string; from?: string; to?: string; limit?: number }) {
    let q = supabaseAdmin
      .from('enrichment_log')
      .select('*')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(filters.limit ?? 200)
    if (filters.customer_id) q = q.eq('customer_id', filters.customer_id)
    if (filters.from)        q = q.gte('created_at', filters.from)
    if (filters.to)          q = q.lte('created_at', filters.to)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** Aggregated stats — small surface for the dashboard "Estatísticas" tab. */
  async stats(orgId: string) {
    const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const { data: rows } = await supabaseAdmin
      .from('enrichment_log')
      .select('query_type, final_provider, final_status, cache_hit, cost_cents, created_at')
      .eq('organization_id', orgId)
      .gte('created_at', since30d)
      .limit(5000)
    const list = (rows ?? []) as Array<Record<string, unknown>>

    const byProvider: Record<string, { queries: number; success: number; cost_cents: number }> = {}
    const byType:     Record<string, { queries: number; success: number }> = {}
    const byDay:      Record<string, number> = {}
    let totalQueries = 0, cacheHits = 0, totalCost = 0

    for (const r of list) {
      totalQueries++
      if (r.cache_hit) cacheHits++
      const cost = Number(r.cost_cents ?? 0)
      totalCost += cost

      const prov = (r.final_provider as string) ?? 'none'
      const succ = ['success', 'partial', 'cached'].includes(r.final_status as string)
      if (!byProvider[prov]) byProvider[prov] = { queries: 0, success: 0, cost_cents: 0 }
      byProvider[prov].queries++
      if (succ) byProvider[prov].success++
      byProvider[prov].cost_cents += cost

      const type = (r.query_type as string) ?? 'unknown'
      if (!byType[type]) byType[type] = { queries: 0, success: 0 }
      byType[type].queries++
      if (succ) byType[type].success++

      const day = (r.created_at as string)?.slice(0, 10) ?? ''
      if (day) byDay[day] = (byDay[day] ?? 0) + 1
    }

    return {
      totals: {
        queries:        totalQueries,
        cache_hits:     cacheHits,
        cache_hit_rate: totalQueries > 0 ? cacheHits / totalQueries : 0,
        cost_brl:       totalCost / 100,
      },
      by_provider: byProvider,
      by_type:     byType,
      by_day:      Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
    }
  }
}
