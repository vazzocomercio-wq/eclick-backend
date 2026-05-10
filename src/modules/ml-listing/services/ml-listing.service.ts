import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { ListingAggregationService } from './listing-aggregation.service'
import { ListingStockScannerService } from './listing-stock-scanner.service'
import { ListingStatusScannerService } from './listing-status-scanner.service'
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
    private readonly aggregation:   ListingAggregationService,
    private readonly stockScanner:  ListingStockScannerService,
    private readonly statusScanner: ListingStatusScannerService,
  ) {}

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
