import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Detecta anúncios sem estoque (available_quantity = 0) e cria tasks
 * `OUT_OF_STOCK`. Auto-resolve quando estoque volta.
 *
 * Fluxo:
 *  1. Lista todos os items ativos do seller (pagina via /users/{id}/items/search)
 *  2. Pra cada item, GET /items/{id} pra checar available_quantity
 *  3. Se 0 → upsert task active de tipo OUT_OF_STOCK
 *  4. Reabertura: se já tinha task aberta e item voltou a ter estoque,
 *     auto-resolve (status = resolved_auto)
 *
 * Pacing: 100ms entre chamadas /items/{id} (10 req/s, ML aguenta bem).
 * Cap defensivo: 5000 items por scan (paginação ML 50/page).
 */
@Injectable()
export class ListingStockScannerService {
  private readonly logger = new Logger(ListingStockScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned: number
    out_of_stock_found: number
    tasks_created: number
    tasks_updated: number
    tasks_resolved_auto: number
    api_calls: number
  }> {
    const t0 = Date.now()
    // Multi-conta — sempre passar sellerId (gotcha feedback_ml_multiconta_token)
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // 1. Pagina items ativos via /users/{seller}/items/search
    const allActiveIds = await this.fetchActiveItemIds(token, sellerId)
    let outOfStock = 0
    let created = 0
    let updated = 0
    let apiCalls = 1 + Math.ceil(allActiveIds.length / 50)

    // 2. Pra cada item, GET full pra checar available_quantity
    // Pacing 100ms entre calls — 10 req/s, ML aguenta sem 429
    for (const itemId of allActiveIds) {
      try {
        const { data: item } = await axios.get(`${ML_BASE}/items/${itemId}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { attributes: 'id,available_quantity,sold_quantity,price,title,last_updated,status' },
          timeout: 8000,
        })
        apiCalls++

        if ((item.available_quantity ?? 0) === 0) {
          outOfStock++
          const result = await this.upsertOutOfStockTask(orgId, sellerId, item)
          if (result === 'created') created++
          else if (result === 'updated') updated++
        }
      } catch (err) {
        this.logger.warn(`[stock-scanner] /items/${itemId}: ${(err as Error).message}`)
      }
      await new Promise(res => setTimeout(res, 100))
    }

    // 3. Auto-resolve tasks OUT_OF_STOCK cujo item voltou a ter estoque
    // (ou seja, NÃO está na lista current de out-of-stock)
    const resolvedAuto = await this.autoResolveRestocked(orgId, sellerId)

    this.logger.log(
      `[stock-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `items=${allActiveIds.length} out_of_stock=${outOfStock} ` +
      `created=${created} updated=${updated} resolved=${resolvedAuto} ` +
      `em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned: allActiveIds.length,
      out_of_stock_found: outOfStock,
      tasks_created: created,
      tasks_updated: updated,
      tasks_resolved_auto: resolvedAuto,
      api_calls: apiCalls,
    }
  }

  private async fetchActiveItemIds(token: string, sellerId: number): Promise<string[]> {
    const ids: string[] = []
    let offset = 0
    const limit = 50
    const SAFETY_CAP = 5000

    while (offset < SAFETY_CAP) {
      try {
        const { data } = await axios.get(`${ML_BASE}/users/${sellerId}/items/search`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { status: 'active', limit, offset },
          timeout: 10_000,
        })
        const page = (data.results ?? []) as string[]
        if (page.length === 0) break
        ids.push(...page)
        if (page.length < limit) break
        offset += limit
      } catch (err) {
        this.logger.warn(`[stock-scanner] search offset=${offset}: ${(err as Error).message}`)
        break
      }
    }
    return ids
  }

  private async upsertOutOfStockTask(
    orgId: string,
    sellerId: number,
    item: { id: string; sold_quantity?: number; price?: number; title?: string; last_updated?: string },
  ): Promise<'created' | 'updated' | 'skipped'> {
    // Severity: vendas recentes + alto volume = critical (perdendo venda)
    const severity = this.computeSeverity(item)
    const priority = this.computePriority(item)
    const monthlyEstimate = this.estimateMonthlyImpact(item)

    // Procura task aberta do mesmo tipo
    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', item.id)
      .eq('task_type', 'OUT_OF_STOCK')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at: new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          severity,
          priority_score: priority,
          updated_at: new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id: orgId,
      seller_id: sellerId,
      ml_item_id: item.id,
      task_type: 'OUT_OF_STOCK',
      task_title: 'Anúncio sem estoque',
      task_description: item.title
        ? `${item.title.slice(0, 60)} · disponível: 0`
        : `Disponível: 0`,
      source: 'scanner_stock',
      severity,
      priority_score: priority,
      impact_area: ['sales', 'reputation'],
      current_value: { stock: 0, price: item.price, sold_quantity: item.sold_quantity },
      suggested_action: 'Repor estoque ou pausar anúncio',
      estimated_impact_brl: monthlyEstimate,
      estimated_impact_description: monthlyEstimate
        ? `Reposição pode trazer ~R$ ${monthlyEstimate.toFixed(0)}/mês`
        : null,
      deeplink_url: `https://eclick.app.br/dashboard/listings/items/${item.id}`,
      deeplink_module: 'listing_center',
      status: 'open',
    })

    if (error) {
      this.logger.warn(`[stock-scanner] insert ${item.id}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  /** Auto-resolve tasks OUT_OF_STOCK que não foram vistas nos últimos 6h
   *  (= item não está mais na lista de out-of-stock no scan corrente). */
  private async autoResolveRestocked(orgId: string, sellerId: number): Promise<number> {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_auto',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Estoque reposto (item não detectado mais como sem estoque)',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('task_type', 'OUT_OF_STOCK')
      .eq('source', 'scanner_stock')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')

    if (error) {
      this.logger.warn(`[stock-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  private computeSeverity(item: { sold_quantity?: number; last_updated?: string }): 'critical' | 'high' | 'medium' | 'low' {
    const sold = item.sold_quantity ?? 0
    const lastUpdated = item.last_updated ? new Date(item.last_updated) : null
    const recentlyUpdated = lastUpdated && (Date.now() - lastUpdated.getTime()) < 7 * 86400_000

    if (sold > 50 && recentlyUpdated) return 'critical'
    if (sold > 10) return 'high'
    if (sold > 0) return 'medium'
    return 'low'
  }

  private computePriority(item: { sold_quantity?: number }): number {
    const sold = item.sold_quantity ?? 0
    // Heurística: items com vendas recentes têm prioridade alta
    if (sold > 100) return 95
    if (sold > 50)  return 85
    if (sold > 10)  return 70
    if (sold > 0)   return 50
    return 30
  }

  private estimateMonthlyImpact(item: { sold_quantity?: number; price?: number }): number | null {
    const sold = item.sold_quantity ?? 0
    const price = item.price ?? 0
    if (sold === 0 || price === 0) return null
    // Aproximação: assume vendas distribuídas em 12 meses → vendas/12 = mensal
    // (ML não devolve período de venda; melhor que nada)
    return Math.round((sold / 12) * price)
  }
}
