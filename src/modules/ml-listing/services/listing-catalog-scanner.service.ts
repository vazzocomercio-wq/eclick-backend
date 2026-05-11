import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Scanner de catálogo / Buy Box elegibilidade.
 *
 * Estratégia low-cost: aproveita o cache do Sprint 3
 * (ml_listing_pricing_suggestions) onde já temos `catalog_product_id`
 * vindo do price_to_win. NÃO precisa de varredura ampla.
 *
 * Pra cada item com catalog_product_id:
 *  1. GET /products/{catalog_id}/items?status=active → competidores
 *  2. Compara: posição do nosso item + boosts ativos vs competidores
 *  3. Cria task CATALOG_ELIGIBLE quando:
 *     - posição > 3 (não tá nos top-3)
 *     - OU competidores top têm free_shipping mas nós não
 *     - OU competidores top têm Full mas nós não
 *
 * Pacing 250ms entre calls /products/.../items.
 */
@Injectable()
export class ListingCatalogScannerService {
  private readonly logger = new Logger(ListingCatalogScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned: number
    tasks_created: number
    tasks_updated: number
    tasks_resolved_auto: number
    api_calls: number
  }> {
    const t0 = Date.now()
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Pega items com catalog_product_id em cache
    const { data: cached } = await supabaseAdmin
      .from('ml_listing_pricing_suggestions')
      .select('ml_item_id, product_id, catalog_product_id, boosts, current_price')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .not('catalog_product_id', 'is', null)
      .limit(500)

    const items = (cached ?? []) as Array<{
      ml_item_id: string
      product_id: string | null
      catalog_product_id: string
      boosts: Record<string, boolean> | null
      current_price: number
    }>

    if (items.length === 0) {
      this.logger.log(`[catalog-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} sem items com catalog_product_id em cache (rode scan/pricing primeiro)`)
      return { items_scanned: 0, tasks_created: 0, tasks_updated: 0, tasks_resolved_auto: 0, api_calls: 0 }
    }

    let created = 0
    let updated = 0
    let apiCalls = 0

    for (const item of items) {
      try {
        const { data: competitors } = await axios.get(
          `${ML_BASE}/products/${item.catalog_product_id}/items`,
          { headers: { Authorization: `Bearer ${token}` }, params: { status: 'active', limit: 10 }, timeout: 8000 },
        )
        apiCalls++

        const results = (competitors?.results ?? []) as Array<{
          item_id: string
          price?: number
          shipping?: { free_shipping?: boolean; logistic_type?: string }
        }>

        const ourPosition = results.findIndex(c => c.item_id === item.ml_item_id)
        const top3 = results.slice(0, 3)
        const competitorsFreeShipping = top3.some(c => c.shipping?.free_shipping)
        const competitorsFulfillment   = top3.some(c => c.shipping?.logistic_type === 'fulfillment')
        const ourFreeShipping = item.boosts?.free_shipping ?? false
        const ourFulfillment  = item.boosts?.fulfillment ?? false

        // Critérios pra criar task CATALOG_ELIGIBLE
        const issues: string[] = []
        if (ourPosition > 2) issues.push(`posição ${ourPosition + 1} no catálogo`)
        if (competitorsFreeShipping && !ourFreeShipping) issues.push('competidor top tem frete grátis e você não')
        if (competitorsFulfillment && !ourFulfillment) issues.push('competidor top usa Full e você não')

        if (issues.length === 0) continue

        const result = await this.upsertCatalogTask(orgId, sellerId, item, ourPosition + 1, results.length, issues)
        if (result === 'created') created++
        else if (result === 'updated') updated++

      } catch (err) {
        // 404 = catálogo descontinuado; só warn
        this.logger.warn(`[catalog-scanner] /products/${item.catalog_product_id}: ${(err as Error).message}`)
      }
      await new Promise(res => setTimeout(res, 250))
    }

    const resolvedAuto = await this.autoResolveStale(orgId, sellerId)

    this.logger.log(
      `[catalog-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `items_with_catalog=${items.length} created=${created} updated=${updated} ` +
      `resolved=${resolvedAuto} em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned: items.length,
      tasks_created: created,
      tasks_updated: updated,
      tasks_resolved_auto: resolvedAuto,
      api_calls: apiCalls,
    }
  }

  private async upsertCatalogTask(
    orgId: string,
    sellerId: number,
    item: { ml_item_id: string; product_id: string | null; catalog_product_id: string },
    position: number,
    totalCompetitors: number,
    issues: string[],
  ): Promise<'created' | 'updated' | 'skipped'> {
    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', item.ml_item_id)
      .eq('task_type', 'CATALOG_ELIGIBLE')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    const severity = position > 5 ? 'medium' : 'low'
    const priority = position > 5 ? 55 : 40
    const title = `Catálogo #${position}/${totalCompetitors} — pode melhorar`
    const description = issues.join(' · ')

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at: new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          severity,
          priority_score: priority,
          task_title: title,
          task_description: description,
          updated_at: new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id: orgId,
      seller_id: sellerId,
      ml_item_id: item.ml_item_id,
      product_id: item.product_id,
      task_type: 'CATALOG_ELIGIBLE',
      task_title: title,
      task_description: description,
      source: 'scanner_catalog',
      severity,
      priority_score: priority,
      impact_area: ['exposure'],
      current_value: { position, total_competitors: totalCompetitors, catalog_product_id: item.catalog_product_id },
      suggested_action: position > 2
        ? 'Avaliar redução de preço ou ativar Full/frete grátis pra subir no catálogo'
        : 'Ativar frete grátis se viável',
      deeplink_url: `https://eclick.app.br/dashboard/listings/items/${item.ml_item_id}`,
      deeplink_module: 'listing_center',
      status: 'open',
    })
    if (error) {
      this.logger.warn(`[catalog-scanner] insert ${item.ml_item_id}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  private async autoResolveStale(orgId: string, sellerId: number): Promise<number> {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_auto',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Posição/boosts no catálogo melhorou',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('source', 'scanner_catalog')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')
    if (error) {
      this.logger.warn(`[catalog-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }
}
