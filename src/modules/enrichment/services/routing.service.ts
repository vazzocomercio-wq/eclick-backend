import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'

export type QueryType = 'cpf' | 'cnpj' | 'phone' | 'whatsapp' | 'email' | 'cep'

export interface RoutingRow {
  query_type:        QueryType
  primary_provider:  string
  fallback_1:        string | null
  fallback_2:        string | null
  fallback_3:        string | null
  cache_ttl_days:    number
  max_retries:       number
}

const DEFAULT_FALLBACK_BY_TYPE: Record<QueryType, RoutingRow> = {
  cpf:      { query_type: 'cpf',      primary_provider: 'bigdatacorp', fallback_1: 'directdata',  fallback_2: 'hubdev',     fallback_3: null,           cache_ttl_days: 90, max_retries: 2 },
  cnpj:     { query_type: 'cnpj',     primary_provider: 'directdata',  fallback_1: 'bigdatacorp', fallback_2: 'hubdev',     fallback_3: null,           cache_ttl_days: 90, max_retries: 2 },
  phone:    { query_type: 'phone',    primary_provider: 'datastone',   fallback_1: 'assertiva',   fallback_2: 'bigdatacorp', fallback_3: null,           cache_ttl_days: 60, max_retries: 2 },
  whatsapp: { query_type: 'whatsapp', primary_provider: 'datastone',   fallback_1: 'assertiva',   fallback_2: null,         fallback_3: null,           cache_ttl_days: 30, max_retries: 2 },
  email:    { query_type: 'email',    primary_provider: 'hubdev',      fallback_1: 'directdata',  fallback_2: null,         fallback_3: null,           cache_ttl_days: 30, max_retries: 2 },
  cep:      { query_type: 'cep',      primary_provider: 'viacep',      fallback_1: 'hubdev',      fallback_2: 'directdata', fallback_3: null,           cache_ttl_days: 365, max_retries: 1 },
}

@Injectable()
export class EnrichmentRoutingService {
  private readonly logger = new Logger(EnrichmentRoutingService.name)

  async resolve(orgId: string, queryType: QueryType): Promise<RoutingRow> {
    try {
      const { data } = await supabaseAdmin
        .from('enrichment_routing')
        .select('*')
        .eq('organization_id', orgId)
        .eq('query_type', queryType)
        .maybeSingle()
      if (data) return data as RoutingRow
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.warn(`[enrichment.routing.resolve] ${err?.message}`)
    }
    return DEFAULT_FALLBACK_BY_TYPE[queryType]
  }

  async listAll(orgId: string): Promise<RoutingRow[]> {
    const { data } = await supabaseAdmin
      .from('enrichment_routing').select('*').eq('organization_id', orgId)
    const byType = new Map<QueryType, RoutingRow>()
    for (const r of (data ?? []) as RoutingRow[]) byType.set(r.query_type, r)
    // Fill in defaults for any type missing in DB
    return (Object.keys(DEFAULT_FALLBACK_BY_TYPE) as QueryType[])
      .map(t => byType.get(t) ?? DEFAULT_FALLBACK_BY_TYPE[t])
  }

  async update(orgId: string, queryType: QueryType, patch: Partial<RoutingRow>): Promise<RoutingRow> {
    const cur = await this.resolve(orgId, queryType)
    const merged = { ...cur, ...patch, organization_id: orgId, query_type: queryType, updated_at: new Date().toISOString() }
    const { data, error } = await supabaseAdmin
      .from('enrichment_routing')
      .upsert(merged, { onConflict: 'organization_id,query_type' })
      .select().single()
    if (error) throw new Error(error.message)
    return data as RoutingRow
  }
}
