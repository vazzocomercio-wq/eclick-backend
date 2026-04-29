import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Logger } from '@nestjs/common'
import { EnrichmentService, EnrichRequest } from './enrichment.service'
import { EnrichmentRoutingService, QueryType, RoutingRow } from './services/routing.service'
import { EnrichmentCostTrackerService, ProviderRow } from './services/cost-tracker.service'
import { EnrichmentConsentService } from './services/consent.service'
import { EnrichmentAuditService } from './services/audit.service'
import { EnrichmentHubService } from './services/hub.service'
import { SupabaseAuthGuard } from '../../common/guards/supabase-auth.guard'
import { ReqUser } from '../../common/decorators/user.decorator'

interface ReqUserPayload { id: string; orgId: string | null }

@Controller('enrichment')
@UseGuards(SupabaseAuthGuard)
export class EnrichmentController {
  private readonly logger = new Logger(EnrichmentController.name)

  constructor(
    private readonly svc:     EnrichmentService,
    private readonly routing: EnrichmentRoutingService,
    private readonly cost:    EnrichmentCostTrackerService,
    private readonly consent: EnrichmentConsentService,
    private readonly audit:   EnrichmentAuditService,
    private readonly hub:     EnrichmentHubService,
  ) {}

  /** Wraps a handler so any throw becomes a typed empty fallback. */
  private async safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn() } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[enrichment] ${label}: ${err?.message}`)
      return fallback
    }
  }

  // ── Providers ──
  @Get('providers')
  providers(@ReqUser() u: ReqUserPayload) {
    return this.safe('providers.list', () => this.cost.listProviders(u.orgId ?? ''), [])
  }

  @Patch('providers/:code')
  updateProvider(
    @ReqUser() u: ReqUserPayload,
    @Param('code') code: string,
    @Body() body: Partial<ProviderRow>,
  ) {
    return this.safe('providers.update',
      () => this.cost.upsertProvider({ ...body, organization_id: u.orgId ?? '', provider_code: code }),
      null)
  }

  @Post('providers/:code/test')
  testProvider(@ReqUser() u: ReqUserPayload, @Param('code') code: string) {
    return this.safe('providers.test', () => this.svc.testProvider(u.orgId ?? '', code), { ok: false, message: 'Erro' })
  }

  // ── Routing ──
  @Get('routing')
  routingList(@ReqUser() u: ReqUserPayload) {
    return this.safe('routing.list', () => this.routing.listAll(u.orgId ?? ''), [])
  }

  @Patch('routing/:queryType')
  routingUpdate(
    @ReqUser() u: ReqUserPayload,
    @Param('queryType') queryType: string,
    @Body() body: Partial<RoutingRow>,
  ) {
    return this.safe('routing.update',
      () => this.routing.update(u.orgId ?? '', queryType as QueryType, body),
      null)
  }

  // ── Enrich ──
  @Post('enrich')
  enrich(@ReqUser() u: ReqUserPayload, @Body() body: Omit<EnrichRequest, 'organization_id' | 'user_id'>) {
    return this.safe('enrich',
      () => this.svc.enrich({ ...body, organization_id: u.orgId ?? '', user_id: u.id }),
      { success: false, quality: 'error' as const, data: {}, error: 'fallback', cost_cents: 0, duration_ms: 0, provider: null, cache_hit: false, attempts: [] })
  }

  /** Enrich N customers in this org. Body: { limit?, customer_ids?,
   * status_filter?, segment? }. Hierarquia de filtros:
   *   1) customer_ids[] (bulk action de /clientes) — usa exatamente esses
   *   2) status_filter ∈ {pending, failed, all} + segment (vip|recent_30d)
   *      — drena fila com filtro
   *   3) default — drena pendentes (legacy behavior)
   * Cap 100, serial com sleep 600ms. */
  @Post('batch')
  batch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: {
      limit?:         number
      customer_ids?:  string[]
      status_filter?: 'pending' | 'failed' | 'all'
      segment?:       'vip' | 'recent_30d'
    },
  ) {
    const ids = Array.isArray(body?.customer_ids) ? body!.customer_ids : undefined
    const cap = Number(body?.limit ?? (ids ? ids.length : 25))
    return this.safe('batch',
      () => this.svc.enrichBatch(u.orgId ?? '', cap, u.id, ids, {
        status_filter: body?.status_filter,
        segment:       body?.segment,
      }),
      { processed: 0, full: 0, partial: 0, failed: 0, skipped: 0, results: [] })
  }

  /** Enrich one specific customer (manual button on /clientes detail). */
  @Post('customer/:id')
  enrichOne(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.safe('customer.enrich',
      () => this.svc.enrichCustomer(u.orgId ?? '', id, u.id),
      { customer_id: id, status: 'failed' as const, provider: null, fields_filled: 0 })
  }

  /** Re-dispara enrichment forçando refresh de cache. Usado pelo botão
   * "Tentar novamente" inline na lista de Failures recentes. */
  @Post('retry/:customerId')
  retry(@ReqUser() u: ReqUserPayload, @Param('customerId') id: string) {
    return this.safe('retry',
      () => this.svc.enrichCustomer(u.orgId ?? '', id, u.id, { force_refresh: true }),
      { customer_id: id, status: 'failed' as const, provider: null, fields_filled: 0 })
  }

  // ── Dashboard (ENRICH-HUB-1) ────────────────────────────────────────────

  @Get('dashboard/kpis')
  kpis(@ReqUser() u: ReqUserPayload) {
    return this.safe('dashboard.kpis',
      () => this.hub.getKpis(u.orgId ?? ''),
      { enriched_full: 0, enriched_partial: 0, total: 0, success_rate_30d: 0, cost_mtd_brl: 0, budget_total_brl: 0, pending_count: 0 })
  }

  @Get('dashboard/timeseries')
  timeseries(@ReqUser() u: ReqUserPayload, @Query('days') days?: string) {
    const n = Math.max(1, Math.min(90, Number(days ?? 30)))
    return this.safe('dashboard.timeseries',
      () => this.hub.getTimeseries(u.orgId ?? '', n),
      [])
  }

  @Get('recent-failures')
  recentFailures(@ReqUser() u: ReqUserPayload, @Query('limit') limit?: string) {
    const n = Math.max(1, Math.min(50, Number(limit ?? 20)))
    return this.safe('recent-failures',
      () => this.hub.getRecentFailures(u.orgId ?? '', n),
      [])
  }

  @Get('queue-stats')
  queueStats(@ReqUser() u: ReqUserPayload) {
    return this.safe('queue-stats',
      () => this.hub.getQueueStats(u.orgId ?? ''),
      { pending: 0, failed: 0, total_eligible: 0, estimated_cost: 0 })
  }

  @Get('auto-enabled')
  getAutoEnabled(@ReqUser() u: ReqUserPayload) {
    return this.safe('auto-enabled.get',
      () => this.hub.getSettings(u.orgId ?? ''),
      { auto_enrichment_enabled: true, post_enrich_delay_minutes: 5 })
  }

  @Patch('auto-enabled')
  patchAutoEnabled(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { auto_enrichment_enabled?: boolean; post_enrich_delay_minutes?: number },
  ) {
    return this.safe('auto-enabled.patch',
      () => this.hub.patchSettings(u.orgId ?? '', body),
      { auto_enrichment_enabled: true, post_enrich_delay_minutes: 5 })
  }

  @Get('post-enrich-template')
  getPostEnrichTemplate(@ReqUser() u: ReqUserPayload) {
    return this.safe('post-enrich-template.get',
      () => this.hub.getPostEnrichTemplate(u.orgId ?? ''),
      { id: null, name: '', message_body: '', is_active: false, delay_minutes: 5 })
  }

  @Post('post-enrich-template')
  upsertPostEnrichTemplate(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { message_body?: string; is_active?: boolean; delay_minutes?: number },
  ) {
    return this.safe('post-enrich-template.upsert',
      () => this.hub.upsertPostEnrichTemplate(u.orgId ?? '', body),
      { id: '', name: '', message_body: '', is_active: false, delay_minutes: 5 })
  }

  // ── Stats / Log ──
  @Get('log')
  log(
    @ReqUser() u: ReqUserPayload,
    @Query('customer_id') customerId?: string,
    @Query('from') from?: string,
    @Query('to')   to?:   string,
  ) {
    return this.safe('log.list',
      () => this.audit.list(u.orgId ?? '', { customer_id: customerId, from, to }), [])
  }

  @Get('stats')
  stats(@ReqUser() u: ReqUserPayload) {
    return this.safe('stats',
      () => this.audit.stats(u.orgId ?? ''),
      { totals: { queries: 0, cache_hits: 0, cache_hit_rate: 0, cost_brl: 0 }, by_provider: {}, by_type: {}, by_day: [] })
  }

  // ── Consent ──
  @Post('consents')
  recordConsent(@ReqUser() u: ReqUserPayload, @Body() body: {
    identifier: string; identifier_type: string; customer_id?: string;
    consent_marketing?:           boolean
    consent_enrichment?:          boolean
    consent_messaging_whatsapp?:  boolean
    consent_messaging_instagram?: boolean
    consent_messaging_tiktok?:    boolean
    source?: string; ip?: string; user_agent?: string;
  }) {
    return this.safe('consents.record',
      () => this.consent.record({ ...body, organization_id: u.orgId ?? '' }),
      null)
  }
}
