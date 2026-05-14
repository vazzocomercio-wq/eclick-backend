import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { ListingAggregationService } from './listing-aggregation.service'
import { ListingStockScannerService } from './listing-stock-scanner.service'
import { ListingStatusScannerService } from './listing-status-scanner.service'
import { ListingPricingScannerService } from './listing-pricing-scanner.service'
import { ListingAutomationScannerService } from './listing-automation-scanner.service'
import { ListingCatalogScannerService } from './listing-catalog-scanner.service'
import { ListingFiscalScannerService } from './listing-fiscal-scanner.service'
import { ListingHealthScoreService } from './listing-health-score.service'
import { ListingBulkActionsService } from './listing-bulk-actions.service'
import { ListingSeoScannerService } from './listing-seo-scanner.service'
import type { TaskStatus, TaskType, TaskSeverity, ScanType, ListingTask, ListingSummary, ScanResult } from '../ml-listing.types'

interface ListTasksFilters {
  task_type?: TaskType
  severity?: TaskSeverity
  status?: TaskStatus
  source?: string
  ml_item_id?: string
  product_id?: string
  seller_id?: number
  offset?: number
  limit?: number
}

/**
 * Orquestrador do F10 ML Listing Center.
 * - CRUD de tasks (list/get/snooze/dismiss/resolve)
 * - Summary (conta por severidade/tipo)
 * - Orchestra scans (full / aggregation / stock — outros virão em sprints futuras)
 * - Mantém scan_logs com status running/completed/failed
 */
@Injectable()
export class MlListingService {
  private readonly logger = new Logger(MlListingService.name)

  constructor(
    private readonly aggregation:       ListingAggregationService,
    private readonly stockScanner:      ListingStockScannerService,
    private readonly statusScanner:     ListingStatusScannerService,
    private readonly pricingScanner:    ListingPricingScannerService,
    private readonly automationScanner: ListingAutomationScannerService,
    private readonly catalogScanner:    ListingCatalogScannerService,
    private readonly fiscalScanner:     ListingFiscalScannerService,
    private readonly healthScoreSvc:    ListingHealthScoreService,
    private readonly bulkActions:       ListingBulkActionsService,
    private readonly seoScanner:        ListingSeoScannerService,
  ) {}

  /** Exposed pra controller invocar direto (apply/activate/configure/fix/score/bulk). */
  pricing():    ListingPricingScannerService    { return this.pricingScanner }
  automation(): ListingAutomationScannerService { return this.automationScanner }
  fiscal():     ListingFiscalScannerService     { return this.fiscalScanner }
  health():     ListingHealthScoreService       { return this.healthScoreSvc }
  bulk():       ListingBulkActionsService       { return this.bulkActions }

  // ── Tasks ────────────────────────────────────────────────────────────────

  async listTasks(orgId: string, filters: ListTasksFilters = {}) {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500)
    const offset = Math.max(filters.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('ml_listing_tasks')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
    if (filters.seller_id != null) q = q.eq('seller_id', filters.seller_id)
    if (filters.task_type)         q = q.eq('task_type', filters.task_type)
    if (filters.severity)          q = q.eq('severity', filters.severity)
    if (filters.status)            q = q.eq('status', filters.status)
    if (filters.source)            q = q.eq('source', filters.source)
    if (filters.ml_item_id)        q = q.eq('ml_item_id', filters.ml_item_id)
    if (filters.product_id)        q = q.eq('product_id', filters.product_id)
    // Default: status = open quando não especificado, ordenando por priority desc
    if (!filters.status)           q = q.in('status', ['open', 'snoozed', 'in_progress'])

    q = q.order('priority_score', { ascending: false, nullsFirst: false })
         .order('created_at', { ascending: false })
         .range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { tasks: (data ?? []) as ListingTask[], total: count ?? 0 }
  }

  async getTask(orgId: string, id: string): Promise<ListingTask> {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException(`Task ${id} não encontrada`)
    return data as ListingTask
  }

  async snoozeTask(orgId: string, id: string, days: number): Promise<ListingTask> {
    const safeDays = Math.min(Math.max(Math.floor(days), 1), 90)
    const until = new Date(Date.now() + safeDays * 86400_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({ status: 'snoozed', snoozed_until: until, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException(`Task ${id} não encontrada`)
    return data as ListingTask
  }

  async dismissTask(orgId: string, id: string, userId: string, reason?: string): Promise<ListingTask> {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'dismissed',
        resolved_by: userId,
        resolved_at: new Date().toISOString(),
        resolution_notes: reason ?? 'Descartada pelo operador',
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException(`Task ${id} não encontrada`)
    return data as ListingTask
  }

  async resolveTaskManual(orgId: string, id: string, userId: string, notes?: string): Promise<ListingTask> {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_manual',
        resolved_by: userId,
        resolved_at: new Date().toISOString(),
        resolution_notes: notes ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) throw new NotFoundException(`Task ${id} não encontrada`)
    return data as ListingTask
  }

  // ── Summary / Dashboard ──────────────────────────────────────────────────

  async getSummary(orgId: string, sellerId?: number): Promise<ListingSummary> {
    let q = supabaseAdmin
      .from('ml_listing_tasks')
      .select('severity, task_type, estimated_impact_brl, status')
      .eq('organization_id', orgId)
      .in('status', ['open', 'snoozed', 'in_progress'])
    if (sellerId != null) q = q.eq('seller_id', sellerId)

    const { data, error } = await q
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as Array<{
      severity: TaskSeverity
      task_type: TaskType
      estimated_impact_brl: number | null
      status: string
    }>

    const summary: ListingSummary = {
      total_open_tasks: 0,
      total_critical: 0,
      total_high: 0,
      total_medium: 0,
      total_low: 0,
      tasks_by_type: {},
      total_estimated_impact_brl: 0,
      high_impact_tasks_count: 0,
      last_full_scan_at: null,
    }

    for (const r of rows) {
      summary.total_open_tasks++
      if (r.severity === 'critical') summary.total_critical++
      else if (r.severity === 'high')   summary.total_high++
      else if (r.severity === 'medium') summary.total_medium++
      else if (r.severity === 'low')    summary.total_low++

      summary.tasks_by_type[r.task_type] = (summary.tasks_by_type[r.task_type] ?? 0) + 1

      const impact = Number(r.estimated_impact_brl ?? 0)
      summary.total_estimated_impact_brl += impact
      if (impact >= 1000) summary.high_impact_tasks_count++
    }

    summary.total_estimated_impact_brl = Math.round(summary.total_estimated_impact_brl * 100) / 100

    // Last full scan
    let scanQ = supabaseAdmin
      .from('ml_listing_scan_logs')
      .select('completed_at')
      .eq('organization_id', orgId)
      .eq('scan_type', 'full')
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
    if (sellerId != null) scanQ = scanQ.eq('seller_id', sellerId)
    const { data: scanRow } = await scanQ.maybeSingle()
    summary.last_full_scan_at = (scanRow as { completed_at?: string } | null)?.completed_at ?? null

    return summary
  }

  // ── Out of stock helper (deeplink-friendly endpoint) ─────────────────────

  async listOutOfStock(orgId: string, sellerId?: number, limit = 100) {
    let q = supabaseAdmin
      .from('ml_listing_tasks')
      .select('*')
      .eq('organization_id', orgId)
      .eq('task_type', 'OUT_OF_STOCK')
      .in('status', ['open', 'snoozed', 'in_progress'])
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    q = q.order('priority_score', { ascending: false }).limit(Math.min(limit, 500))

    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  // ── Scans ────────────────────────────────────────────────────────────────

  async runFullScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'full')
    const t0 = Date.now()
    let result: ScanResult = {
      scan_type: 'full', items_scanned: 0,
      tasks_created: 0, tasks_updated: 0, tasks_resolved_auto: 0,
      api_calls_count: 0, errors_count: 0, duration_seconds: 0, status: 'completed',
    }
    try {
      const agg = await this.aggregation.aggregateSignals(orgId, sellerId)
      result.tasks_created       += agg.created
      result.tasks_updated       += agg.updated
      result.tasks_resolved_auto += agg.resolved_auto

      const stock = await this.stockScanner.scan(orgId, sellerId)
      result.items_scanned       += stock.items_scanned
      result.tasks_created       += stock.tasks_created
      result.tasks_updated       += stock.tasks_updated
      result.tasks_resolved_auto += stock.tasks_resolved_auto
      result.api_calls_count     += stock.api_calls

      const status = await this.statusScanner.scan(orgId, sellerId)
      result.items_scanned       += status.items_scanned
      result.tasks_created       += status.tasks_created
      result.tasks_updated       += status.tasks_updated
      result.tasks_resolved_auto += status.tasks_resolved_auto
      result.api_calls_count     += status.api_calls

      const pricing = await this.pricingScanner.scan(orgId, sellerId)
      result.items_scanned       += pricing.items_scanned
      result.tasks_created       += pricing.tasks_created
      result.tasks_updated       += pricing.tasks_updated
      result.tasks_resolved_auto += pricing.tasks_resolved_auto
      result.api_calls_count     += pricing.api_calls

      // Catalog scanner depende do cache populado por pricingScanner (catalog_product_id)
      const catalog = await this.catalogScanner.scan(orgId, sellerId)
      result.tasks_created       += catalog.tasks_created
      result.tasks_updated       += catalog.tasks_updated
      result.tasks_resolved_auto += catalog.tasks_resolved_auto
      result.api_calls_count     += catalog.api_calls

      const automation = await this.automationScanner.scan(orgId, sellerId)
      result.tasks_created       += automation.tasks_created
      result.tasks_updated       += automation.tasks_updated
      result.tasks_resolved_auto += automation.tasks_resolved_auto
      result.api_calls_count     += automation.api_calls

      const fiscal = await this.fiscalScanner.scan(orgId, sellerId)
      result.items_scanned       += fiscal.items_scanned
      result.tasks_created       += fiscal.tasks_created
      result.tasks_updated       += fiscal.tasks_updated
      result.tasks_resolved_auto += fiscal.tasks_resolved_auto
      result.api_calls_count     += fiscal.api_calls

      const seo = await this.seoScanner.scan(orgId, sellerId)
      result.items_scanned       += seo.items_scanned
      result.tasks_created       += seo.tasks_created
      result.tasks_updated       += seo.tasks_updated
      result.tasks_resolved_auto += seo.tasks_resolved_auto
      result.api_calls_count     += seo.api_calls

      result.duration_seconds = Math.round((Date.now() - t0) / 1000)
      await this.completeScanLog(log.id, result)
    } catch (err) {
      result.status = 'failed'
      result.duration_seconds = Math.round((Date.now() - t0) / 1000)
      await this.failScanLog(log.id, err as Error, result)
      throw err
    }
    return result
  }

  async runAggregationOnly(orgId: string, sellerId?: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId ?? null, 'aggregation_only')
    const t0 = Date.now()
    try {
      const agg = await this.aggregation.aggregateSignals(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'aggregation_only',
        items_scanned: 0,
        tasks_created: agg.created,
        tasks_updated: agg.updated,
        tasks_resolved_auto: agg.resolved_auto,
        api_calls_count: 0,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async runStockScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_stock')
    const t0 = Date.now()
    try {
      const stock = await this.stockScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'scanner_stock',
        items_scanned: stock.items_scanned,
        tasks_created: stock.tasks_created,
        tasks_updated: stock.tasks_updated,
        tasks_resolved_auto: stock.tasks_resolved_auto,
        api_calls_count: stock.api_calls,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async runFiscalScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_fiscal')
    const t0 = Date.now()
    try {
      const f = await this.fiscalScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'scanner_fiscal',
        items_scanned: f.items_scanned,
        tasks_created: f.tasks_created,
        tasks_updated: f.tasks_updated,
        tasks_resolved_auto: f.tasks_resolved_auto,
        api_calls_count: f.api_calls,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async runAutomationScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_automation')
    const t0 = Date.now()
    try {
      const a = await this.automationScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'scanner_automation',
        items_scanned: a.items_scanned,
        tasks_created: a.tasks_created,
        tasks_updated: a.tasks_updated,
        tasks_resolved_auto: a.tasks_resolved_auto,
        api_calls_count: a.api_calls,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async runCatalogScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_catalog')
    const t0 = Date.now()
    try {
      const c = await this.catalogScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'scanner_catalog',
        items_scanned: c.items_scanned,
        tasks_created: c.tasks_created,
        tasks_updated: c.tasks_updated,
        tasks_resolved_auto: c.tasks_resolved_auto,
        api_calls_count: c.api_calls,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async runPricingScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_pricing')
    const t0 = Date.now()
    try {
      const p = await this.pricingScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'scanner_pricing',
        items_scanned: p.items_scanned,
        tasks_created: p.tasks_created,
        tasks_updated: p.tasks_updated,
        tasks_resolved_auto: p.tasks_resolved_auto,
        api_calls_count: p.api_calls,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async listPricingSuggestions(orgId: string, opts: {
    seller_id?: number
    buy_box_status?: 'winning' | 'losing' | 'sharing_first_place'
    min_diff_pct?: number
    limit?: number
    offset?: number
  } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('ml_listing_pricing_suggestions')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
    if (opts.seller_id != null)     q = q.eq('seller_id', opts.seller_id)
    if (opts.buy_box_status)        q = q.eq('buy_box_status', opts.buy_box_status)
    if (opts.min_diff_pct != null)  q = q.gte('price_difference_pct', opts.min_diff_pct)
    q = q.order('price_difference_pct', { ascending: false, nullsFirst: false })
         .range(offset, offset + limit - 1)
    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { suggestions: data ?? [], total: count ?? 0 }
  }

  async runStatusScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_status')
    const t0 = Date.now()
    try {
      const s = await this.statusScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type: 'scanner_status',
        items_scanned: s.items_scanned,
        tasks_created: s.tasks_created,
        tasks_updated: s.tasks_updated,
        tasks_resolved_auto: s.tasks_resolved_auto,
        api_calls_count: s.api_calls,
        errors_count: 0,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
        status: 'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  async listInactive(orgId: string, sellerId?: number, limit = 100) {
    let q = supabaseAdmin
      .from('ml_listing_tasks')
      .select('*')
      .eq('organization_id', orgId)
      .eq('task_type', 'INACTIVE_PAUSED')
      .in('status', ['open', 'snoozed', 'in_progress'])
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    q = q.order('priority_score', { ascending: false }).limit(Math.min(limit, 500))
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** Sprint 6 — agrupa pausados por categoria (UI: dashboard policy). */
  async policyByCategory(orgId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_listing_pause_classifications')
      .select('pause_category, pause_severity, ml_item_id, item_title, item_price, item_sold_quantity, days_paused, is_self_solvable, suggested_fix')
      .eq('organization_id', orgId)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    q = q.order('pause_severity', { ascending: true })
         .order('days_paused', { ascending: false, nullsFirst: false })
         .limit(2000)

    const { data, error } = await q
    if (error) throw new Error(error.message)

    type Row = {
      pause_category: string; pause_severity: string
      ml_item_id: string; item_title: string | null; item_price: number | null
      item_sold_quantity: number | null; days_paused: number | null
      is_self_solvable: boolean; suggested_fix: string | null
    }
    const rows = (data ?? []) as Row[]

    // Agrupa
    const groups: Record<string, { count: number; severity: string; suggested_fix: string | null; items: Row[] }> = {}
    for (const r of rows) {
      const k = r.pause_category ?? 'unknown'
      if (!groups[k]) groups[k] = { count: 0, severity: r.pause_severity, suggested_fix: r.suggested_fix, items: [] }
      groups[k].count++
      groups[k].items.push(r)
    }
    // Sort categorias por severity → critical first
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>
    return Object.entries(groups)
      .map(([category, g]) => ({ category, ...g, items: g.items.slice(0, 50) /* sample */ }))
      .sort((a, b) => (sevOrder[a.severity] ?? 99) - (sevOrder[b.severity] ?? 99))
  }

  /** Sprint 6 — só os casos críticos (policy_violation, restricted_product). */
  async policyCritical(orgId: string, sellerId?: number) {
    let q = supabaseAdmin
      .from('ml_listing_pause_classifications')
      .select('*')
      .eq('organization_id', orgId)
      .in('pause_category', ['policy_violation', 'restricted_product'])
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    q = q.order('days_paused', { ascending: false, nullsFirst: false }).limit(500)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** Sprint 6 — lista filtrada por categoria específica. */
  async policyList(orgId: string, opts: { seller_id?: number; category?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
    let q = supabaseAdmin
      .from('ml_listing_pause_classifications')
      .select('*')
      .eq('organization_id', orgId)
    if (opts.seller_id != null) q = q.eq('seller_id', opts.seller_id)
    if (opts.category)          q = q.eq('pause_category', opts.category)
    q = q.order('days_paused', { ascending: false, nullsFirst: false }).limit(limit)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  // ── SEO Scanner (F10 Passo 2) ────────────────────────────────────────────

  async runSeoScan(orgId: string, sellerId: number): Promise<ScanResult> {
    const log = await this.startScanLog(orgId, sellerId, 'scanner_seo')
    const t0 = Date.now()
    try {
      const s = await this.seoScanner.scan(orgId, sellerId)
      const result: ScanResult = {
        scan_type:           'scanner_seo',
        items_scanned:       s.items_scanned,
        tasks_created:       s.tasks_created,
        tasks_updated:       s.tasks_updated,
        tasks_resolved_auto: s.tasks_resolved_auto,
        api_calls_count:     s.api_calls,
        errors_count:        0,
        duration_seconds:    Math.round((Date.now() - t0) / 1000),
        status:              'completed',
      }
      await this.completeScanLog(log.id, result)
      return result
    } catch (err) {
      await this.failScanLog(log.id, err as Error)
      throw err
    }
  }

  /** Lista scores SEO ordenado por structural_score asc (piores primeiro). */
  async listSeoScores(orgId: string, opts: {
    seller_id?:   number
    max_score?:   number
    min_visits?:  number
    limit?:       number
    offset?:      number
  } = {}) {
    const limit  = Math.min(Math.max(opts.limit ?? 50, 1), 500)
    const offset = Math.max(opts.offset ?? 0, 0)
    let q = supabaseAdmin
      .from('ml_listing_seo_scores')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
    if (opts.seller_id != null)   q = q.eq('seller_id', opts.seller_id)
    if (opts.max_score != null)   q = q.lte('structural_score', opts.max_score)
    if (opts.min_visits != null)  q = q.gte('visits_30d', opts.min_visits)
    q = q.order('structural_score', { ascending: true })
         .order('visits_30d', { ascending: false, nullsFirst: false })
         .range(offset, offset + limit - 1)
    const { data, error, count } = await q
    if (error) throw new Error(error.message)
    return { scores: data ?? [], total: count ?? 0 }
  }

  /** Top ROI: visitas × penalidade-de-score. Passo 3. */
  async listSeoTopOpportunities(orgId: string, opts: { seller_id?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100)
    let q = supabaseAdmin
      .from('ml_listing_seo_scores')
      .select('ml_item_id, seller_id, title, structural_score, title_score, attributes_score, pictures_score, visits_30d, sold_quantity, price, listing_type_id, last_scanned_at, issues')
      .eq('organization_id', orgId)
      .not('visits_30d', 'is', null)
      .gt('visits_30d', 0)
      .lt('structural_score', 80)
    if (opts.seller_id != null) q = q.eq('seller_id', opts.seller_id)
    // PostgREST não suporta orderBy expressão calc; pega top N por visits e ordena em memória
    q = q.order('visits_30d', { ascending: false }).limit(limit * 5)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    type Row = {
      ml_item_id: string; visits_30d: number | null; structural_score: number;
      title: string | null; sold_quantity: number | null;
    } & Record<string, unknown>
    const rows = (data ?? []) as Row[]
    const scored = rows
      .map(r => ({
        ...r,
        roi_score: (r.visits_30d ?? 0) * (100 - r.structural_score),
      }))
      .sort((a, b) => b.roi_score - a.roi_score)
      .slice(0, limit)
    return scored
  }

  async getSeoScoreByItem(orgId: string, mlItemId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_seo_scores')
      .select('*')
      .eq('organization_id', orgId)
      .eq('ml_item_id', mlItemId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data
  }

  /** Tasks de um anúncio específico (visão consolidada). */
  async listTasksByItem(orgId: string, itemId: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('*')
      .eq('organization_id', orgId)
      .eq('ml_item_id', itemId)
      .order('status', { ascending: true })
      .order('priority_score', { ascending: false, nullsFirst: false })
    if (error) throw new Error(error.message)
    return data ?? []
  }

  // ── Scan logs helpers ────────────────────────────────────────────────────

  private async startScanLog(orgId: string, sellerId: number | null, scanType: ScanType): Promise<{ id: string }> {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_scan_logs')
      .insert({
        organization_id: orgId,
        seller_id: sellerId,
        scan_type: scanType,
        status: 'running',
      })
      .select('id')
      .single()
    if (error) throw new BadRequestException(`Falha ao criar scan log: ${error.message}`)
    return data as { id: string }
  }

  private async completeScanLog(id: string, result: ScanResult) {
    await supabaseAdmin
      .from('ml_listing_scan_logs')
      .update({
        status: result.status,
        items_scanned: result.items_scanned,
        tasks_created: result.tasks_created,
        tasks_updated: result.tasks_updated,
        tasks_resolved_auto: result.tasks_resolved_auto,
        api_calls_count: result.api_calls_count,
        errors_count: result.errors_count,
        duration_seconds: result.duration_seconds,
        completed_at: new Date().toISOString(),
      })
      .eq('id', id)
  }

  private async failScanLog(id: string, err: Error, partial?: ScanResult) {
    await supabaseAdmin
      .from('ml_listing_scan_logs')
      .update({
        status: 'failed',
        errors_count: 1,
        error_details: [{ message: err.message, stack: err.stack?.slice(0, 500) }],
        completed_at: new Date().toISOString(),
        items_scanned: partial?.items_scanned ?? 0,
        tasks_created: partial?.tasks_created ?? 0,
        tasks_updated: partial?.tasks_updated ?? 0,
        duration_seconds: partial?.duration_seconds ?? 0,
      })
      .eq('id', id)
    this.logger.error(`[scan-log] ${id} falhou: ${err.message}`)
  }
}
