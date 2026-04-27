import { Injectable, Inject, Logger } from '@nestjs/common'
import { ENRICHMENT_PROVIDERS, BaseEnrichmentProvider, EnrichmentResult } from './providers'
import { EnrichmentRoutingService, QueryType } from './services/routing.service'
import { EnrichmentCacheService } from './services/cache.service'
import { EnrichmentConsentService } from './services/consent.service'
import { EnrichmentAuditService } from './services/audit.service'
import { EnrichmentCostTrackerService } from './services/cost-tracker.service'

export interface EnrichRequest {
  organization_id: string
  user_id?:        string | null
  query_type:      QueryType
  query_value:     string
  customer_id?:    string | null
  order_id?:       string | null
  trigger_source?: 'manual' | 'auto' | 'batch'
  force_refresh?:  boolean
}

export interface EnrichResponse extends EnrichmentResult {
  provider:    string | null
  cache_hit:   boolean
  attempts:    Array<{ provider: string; status: string; error?: string }>
}

@Injectable()
export class EnrichmentService {
  private readonly logger = new Logger(EnrichmentService.name)

  constructor(
    @Inject(ENRICHMENT_PROVIDERS) private readonly registry: Map<string, BaseEnrichmentProvider>,
    private readonly routing: EnrichmentRoutingService,
    private readonly cache:   EnrichmentCacheService,
    private readonly consent: EnrichmentConsentService,
    private readonly audit:   EnrichmentAuditService,
    private readonly cost:    EnrichmentCostTrackerService,
  ) {}

  async enrich(req: EnrichRequest): Promise<EnrichResponse> {
    const t0 = Date.now()
    const trigger = req.trigger_source ?? 'manual'

    // 1. Consent check (CEP exempt)
    if (req.query_type !== 'cep') {
      const ok = await this.consent.check(req.organization_id, req.query_type, req.query_value)
      if (!ok) {
        await this.audit.log({
          organization_id: req.organization_id, user_id: req.user_id,
          query_type: req.query_type, query_value: req.query_value,
          trigger_source: trigger, provider_attempts: [],
          final_status: 'failed', duration_ms: Date.now() - t0,
          customer_id: req.customer_id, order_id: req.order_id,
        })
        return this.notOk('no_consent', t0)
      }
    }

    // 2. Cache lookup unless force_refresh
    if (!req.force_refresh) {
      const cached = await this.cache.lookup(req.organization_id, req.query_type, req.query_value)
      if (cached) {
        await this.audit.log({
          organization_id: req.organization_id, user_id: req.user_id,
          query_type: req.query_type, query_value: req.query_value,
          trigger_source: trigger, provider_attempts: [],
          final_provider: cached.provider, final_status: 'cached',
          duration_ms: Date.now() - t0, cache_hit: true,
          customer_id: req.customer_id, order_id: req.order_id,
        })
        return { ...cached.result, provider: cached.provider, cache_hit: true, attempts: [] }
      }
    }

    // 3. Resolve cascade
    const route = await this.routing.resolve(req.organization_id, req.query_type)
    const codes = [route.primary_provider, route.fallback_1, route.fallback_2, route.fallback_3]
      .filter((c): c is string => !!c)

    const attempts: Array<{ provider: string; status: string; error?: string; duration_ms?: number }> = []
    let last: { code: string; result: EnrichmentResult } | null = null

    // 4. Walk providers until one returns full/partial
    for (const code of codes) {
      const provider = this.registry.get(code)
      if (!provider) {
        attempts.push({ provider: code, status: 'unknown' })
        continue
      }

      // ViaCEP doesn't need creds; everyone else must be enabled + have budget
      let creds: { api_key: string | null; api_secret: string | null; base_url: string | null } | null = null
      if (code === 'viacep') {
        creds = { api_key: null, api_secret: null, base_url: null }
      } else {
        const row = await this.cost.getProvider(req.organization_id, code)
        if (!row || !row.is_enabled) { attempts.push({ provider: code, status: 'disabled' }); continue }
        const ok = await this.cost.hasBudget(req.organization_id, code)
        if (!ok) { attempts.push({ provider: code, status: 'no_credit' }); continue }
        creds = { api_key: row.api_key ?? null, api_secret: row.api_secret ?? null, base_url: row.base_url ?? null }
      }

      const r = await this.callProvider(provider, req.query_type, req.query_value, creds)
      attempts.push({ provider: code, status: r.quality, error: r.error, duration_ms: r.duration_ms })
      last = { code, result: r }

      if (r.quality === 'full' || r.quality === 'partial') {
        await this.cache.store(req.organization_id, req.query_type, req.query_value, code, r, route.cache_ttl_days)
        await this.cost.track(req.organization_id, code, r.cost_cents)
        await this.audit.log({
          organization_id: req.organization_id, user_id: req.user_id,
          query_type: req.query_type, query_value: req.query_value,
          trigger_source: trigger, provider_attempts: attempts,
          final_provider: code, final_status: r.quality === 'full' ? 'success' : 'partial',
          duration_ms: Date.now() - t0, cost_cents: r.cost_cents, cache_hit: false,
          customer_id: req.customer_id, order_id: req.order_id,
        })
        return { ...r, provider: code, cache_hit: false, attempts }
      }
    }

    // 5. All failed — store an empty cache entry so we don't retry a CPF
    // we just confirmed no provider has, until TTL expires.
    if (last && last.result.quality === 'empty') {
      await this.cache.store(req.organization_id, req.query_type, req.query_value, last.code, last.result, route.cache_ttl_days)
    }
    await this.audit.log({
      organization_id: req.organization_id, user_id: req.user_id,
      query_type: req.query_type, query_value: req.query_value,
      trigger_source: trigger, provider_attempts: attempts,
      final_provider: last?.code ?? null,
      final_status: 'failed', duration_ms: Date.now() - t0,
      customer_id: req.customer_id, order_id: req.order_id,
    })
    return { ...(last?.result ?? this.emptyResult()), provider: last?.code ?? null, cache_hit: false, attempts }
  }

  private async callProvider(
    p: BaseEnrichmentProvider,
    qt: QueryType,
    value: string,
    creds: { api_key: string | null; api_secret: string | null; base_url: string | null },
  ): Promise<EnrichmentResult> {
    try {
      switch (qt) {
        case 'cpf':      return await p.enrichCPF(value, creds)
        case 'cnpj':     return await p.enrichCNPJ(value, creds)
        case 'phone':    return await p.enrichPhone(value, creds)
        case 'whatsapp': return await p.validateWhatsApp(value, creds)
        case 'email':    return await p.validateEmail(value, creds)
        case 'cep':      return await p.enrichCEP(value, creds)
        default:         return this.emptyResult()
      }
    } catch (e: unknown) {
      const err = e as { message?: string }
      return { ...this.emptyResult(), quality: 'error', error: err?.message ?? '' }
    }
  }

  private emptyResult(): EnrichmentResult {
    return { success: false, quality: 'empty', data: {}, cost_cents: 0, duration_ms: 0 }
  }

  private notOk(error: string, t0: number): EnrichResponse {
    return { ...this.emptyResult(), quality: 'error', error, duration_ms: Date.now() - t0, provider: null, cache_hit: false, attempts: [] }
  }

  /** Test provider credentials via the per-provider healthCheck — each
   * provider hits a free endpoint (balance/OAuth/shape) so the test
   * never consumes a paid quota. */
  async testProvider(orgId: string, code: string): Promise<{ ok: boolean; message: string; metadata?: Record<string, unknown> }> {
    const provider = this.registry.get(code)
    if (!provider) return { ok: false, message: 'Provedor desconhecido' }
    if (code === 'viacep') {
      return await provider.healthCheck({ api_key: null, api_secret: null, base_url: null })
    }
    const row = await this.cost.getProvider(orgId, code)
    if (!row || !row.api_key) return { ok: false, message: 'Sem api_key configurada' }
    return await provider.healthCheck({ api_key: row.api_key, api_secret: row.api_secret, base_url: row.base_url })
  }
}
