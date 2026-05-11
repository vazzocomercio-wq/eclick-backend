import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { ListingPricingScannerService } from './listing-pricing-scanner.service'

type ActionType =
  | 'apply_price_suggestions'
  | 'snooze_tasks'
  | 'dismiss_tasks'
  | 'resolve_tasks_manual'
type ApplyMode = 'safe' | 'best_effort' | 'dry_run'

interface BulkActionResult {
  item_id_or_task_id: string
  status: 'applied' | 'failed' | 'skipped'
  message?: string
  new_price?: number
}

/**
 * Bulk actions service (L4 Sprint 8).
 *
 * Suporta 4 operações pra MVP:
 *  - apply_price_suggestions — aplica price_to_win em lote (mode=safe valida margem)
 *  - resolve_tasks_manual    — marca N tasks como resolvidas
 *  - snooze_tasks            — adia N tasks por X dias
 *  - dismiss_tasks           — descarta N tasks
 *
 * Cada execução cria 1 row em ml_listing_bulk_actions e roda em
 * fire-and-forget (retorna 202 + bulk_action_id imediatamente; UI faz
 * polling em GET /listings/bulk/actions/:id pra ver progresso).
 *
 * apply_mode:
 *  - safe (default): valida cada item antes de aplicar (skip se inválido)
 *  - best_effort: tenta aplicar mesmo com warnings (ainda valida bloqueios duros)
 *  - dry_run: simula sem aplicar (retorna o que SERIA feito)
 */
@Injectable()
export class ListingBulkActionsService {
  private readonly logger = new Logger(ListingBulkActionsService.name)

  constructor(private readonly pricingScanner: ListingPricingScannerService) {}

  /** Cria a row + dispara execução assíncrona. Retorna ID pra polling. */
  async startBulkAction(input: {
    orgId: string
    sellerId: number
    userId: string | null
    action_type: ActionType
    task_ids?: string[]
    item_ids?: string[]
    filter_rules?: Record<string, unknown>
    apply_mode?: ApplyMode
    days?: number       // pra snooze
    reason?: string     // pra dismiss
    notes?: string      // pra resolve_manual
  }): Promise<{ bulk_action_id: string }> {
    const taskIds = input.task_ids ?? []
    const itemIds = input.item_ids ?? []
    const totalCount = taskIds.length + itemIds.length
    if (totalCount === 0 && !input.filter_rules) {
      throw new Error('task_ids, item_ids ou filter_rules requerido')
    }

    const { data, error } = await supabaseAdmin
      .from('ml_listing_bulk_actions')
      .insert({
        organization_id: input.orgId,
        seller_id:       input.sellerId,
        user_id:         input.userId,
        action_type:     input.action_type,
        task_ids:        taskIds,
        item_ids:        itemIds,
        filter_rules:    input.filter_rules ?? {},
        apply_mode:      input.apply_mode ?? 'safe',
        status:          'pending',
        total_count:     totalCount,
      })
      .select('id')
      .single()
    if (error) throw new Error(`Falha criar bulk_action: ${error.message}`)
    const bulkActionId = (data as { id: string }).id

    // Fire-and-forget
    void this.execute(bulkActionId, input).catch(err => {
      this.logger.error(`[bulk-action] ${bulkActionId} falhou: ${(err as Error).message}`)
    })

    return { bulk_action_id: bulkActionId }
  }

  private async execute(bulkActionId: string, input: Parameters<ListingBulkActionsService['startBulkAction']>[0]): Promise<void> {
    await this.updateAction(bulkActionId, { status: 'executing', started_at: new Date().toISOString() })

    const results: BulkActionResult[] = []
    let applied = 0
    let failed = 0
    let skipped = 0

    try {
      if (input.action_type === 'apply_price_suggestions') {
        const itemIds = input.item_ids ?? []
        for (const itemId of itemIds) {
          try {
            if (input.apply_mode === 'dry_run') {
              const sugg = await this.pricingScanner.getSuggestion(input.orgId, input.sellerId, itemId)
              if (!sugg) {
                results.push({ item_id_or_task_id: itemId, status: 'skipped', message: 'sugestão não encontrada' })
                skipped++
              } else {
                results.push({
                  item_id_or_task_id: itemId,
                  status: 'applied',
                  message: 'dry-run: aplicaria',
                  new_price: (sugg as { suggested_price: number }).suggested_price,
                })
                applied++
              }
            } else {
              const r = await this.pricingScanner.applyPrice(
                input.orgId, input.sellerId, itemId,
                input.apply_mode === 'best_effort' ? 'force' : 'safe',
              )
              if (r.success) {
                results.push({ item_id_or_task_id: itemId, status: 'applied', new_price: r.new_price })
                applied++
              } else {
                results.push({ item_id_or_task_id: itemId, status: 'skipped', message: r.skipped_reason })
                skipped++
              }
            }
          } catch (err) {
            results.push({ item_id_or_task_id: itemId, status: 'failed', message: (err as Error).message })
            failed++
          }
          // Pacing 300ms entre items pra não saturar ML
          await new Promise(res => setTimeout(res, 300))
          // Update progresso parcial a cada 10 items pra UI poder fazer polling
          if ((applied + failed + skipped) % 10 === 0) {
            await this.updateAction(bulkActionId, {
              applied_count: applied, failed_count: failed, skipped_count: skipped,
              results,
            })
          }
        }
      } else if (input.action_type === 'snooze_tasks' || input.action_type === 'dismiss_tasks' || input.action_type === 'resolve_tasks_manual') {
        const taskIds = input.task_ids ?? []
        const days   = Math.min(Math.max(input.days ?? 7, 1), 90)
        const action = input.action_type
        const newStatus = action === 'snooze_tasks' ? 'snoozed'
                       : action === 'dismiss_tasks' ? 'dismissed'
                       : 'resolved_manual'

        const update: Record<string, unknown> = {
          status: newStatus,
          updated_at: new Date().toISOString(),
        }
        if (action === 'snooze_tasks') update.snoozed_until = new Date(Date.now() + days * 86400_000).toISOString()
        if (action === 'dismiss_tasks') {
          update.resolved_at = new Date().toISOString()
          update.resolved_by = input.userId
          update.resolution_notes = input.reason ?? 'Descartada em lote'
        }
        if (action === 'resolve_tasks_manual') {
          update.resolved_at = new Date().toISOString()
          update.resolved_by = input.userId
          update.resolution_notes = input.notes ?? 'Resolvida em lote'
        }

        const BATCH = 100
        for (let i = 0; i < taskIds.length; i += BATCH) {
          const batch = taskIds.slice(i, i + BATCH)
          const { error: upErr } = await supabaseAdmin
            .from('ml_listing_tasks')
            .update(update)
            .eq('organization_id', input.orgId)
            .eq('seller_id', input.sellerId)
            .in('id', batch)
            .in('status', ['open', 'snoozed', 'in_progress'])
          if (upErr) {
            for (const id of batch) results.push({ item_id_or_task_id: id, status: 'failed', message: upErr.message })
            failed += batch.length
          } else {
            for (const id of batch) results.push({ item_id_or_task_id: id, status: 'applied' })
            applied += batch.length
          }
        }
      }

      // Final update
      const finalStatus = failed === 0 ? 'completed' : (applied > 0 ? 'partial' : 'failed')
      await this.updateAction(bulkActionId, {
        status:         finalStatus,
        applied_count:  applied,
        failed_count:   failed,
        skipped_count:  skipped,
        results,
        completed_at:   new Date().toISOString(),
      })
      this.logger.log(`[bulk-action] ${bulkActionId} ${finalStatus} applied=${applied} skipped=${skipped} failed=${failed}`)
    } catch (err) {
      await this.updateAction(bulkActionId, {
        status: 'failed',
        completed_at: new Date().toISOString(),
        results: [...results, { item_id_or_task_id: 'GLOBAL', status: 'failed', message: (err as Error).message }],
      })
      throw err
    }
  }

  private async updateAction(id: string, patch: Record<string, unknown>) {
    await supabaseAdmin.from('ml_listing_bulk_actions').update(patch).eq('id', id)
  }

  async listActions(orgId: string, opts: { seller_id?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    let q = supabaseAdmin
      .from('ml_listing_bulk_actions')
      .select('id, action_type, apply_mode, status, total_count, applied_count, failed_count, skipped_count, started_at, completed_at, created_at, user_id')
      .eq('organization_id', orgId)
    if (opts.seller_id != null) q = q.eq('seller_id', opts.seller_id)
    q = q.order('created_at', { ascending: false }).limit(limit)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  async getAction(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('ml_listing_bulk_actions')
      .select('*')
      .eq('organization_id', orgId)
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data
  }
}
