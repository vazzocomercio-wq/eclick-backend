import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards, Logger } from '@nestjs/common'
import { EnrichmentService, EnrichRequest } from './enrichment.service'
import { EnrichmentRoutingService, QueryType, RoutingRow } from './services/routing.service'
import { EnrichmentCostTrackerService, ProviderRow } from './services/cost-tracker.service'
import { EnrichmentConsentService } from './services/consent.service'
import { EnrichmentAuditService } from './services/audit.service'
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

  /** Enrich N customers in this org. Body: { limit?: number, customer_ids?: string[] }.
   * Quando customer_ids vem (bulk action de /clientes), processa esses IDs
   * direto — sem o filtro enrichment_status=pending. Caso contrário, drena
   * fila de pendentes (default 25, max 100). Sequential to spread provider load. */
  @Post('batch')
  batch(
    @ReqUser() u: ReqUserPayload,
    @Body() body: { limit?: number; customer_ids?: string[] },
  ) {
    const ids = Array.isArray(body?.customer_ids) ? body!.customer_ids : undefined
    const cap = Number(body?.limit ?? (ids ? ids.length : 25))
    return this.safe('batch',
      () => this.svc.enrichBatch(u.orgId ?? '', cap, u.id, ids),
      { processed: 0, full: 0, partial: 0, failed: 0, skipped: 0, results: [] })
  }

  /** Enrich one specific customer (manual button on /clientes detail). */
  @Post('customer/:id')
  enrichOne(@ReqUser() u: ReqUserPayload, @Param('id') id: string) {
    return this.safe('customer.enrich',
      () => this.svc.enrichCustomer(u.orgId ?? '', id, u.id),
      { customer_id: id, status: 'failed' as const, provider: null, fields_filled: 0 })
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
