import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Scanner de sugestões de preço — fluxo 2-step pós-smoke-test.
 *
 * Step 1: GET /suggestions/user/{seller}/items → lista IDs com sugestão
 *         (1 chamada, retorna até ~1k IDs).
 * Step 2: GET /items/{id}/price_to_win → pra cada ID, captura:
 *   - price_to_win (preço pra ganhar Buy Box)
 *   - status (winning | losing | sharing_first_place)
 *   - visit_share (maximum | medium | low)
 *   - competitors_sharing_first_place
 *   - reason[] (motivos de estar perdendo)
 *   - catalog_product_id (desbloqueia card CATALOG_ELIGIBLE em Sprint 4)
 *   - winner (item_id + price)
 *   - boosts (free_shipping, fulfillment, cross_docking, etc.)
 *
 * Cria 2 tipos de tarefas:
 *  - PRICE_HIGH (preço >5% acima do sugerido E acima do custo)
 *  - LOSING_BUY_BOX (status=losing OU competitors_sharing > 0)
 *
 * Auto-resolve em ambas: quando sinal sai da lista (ajustou preço, ganhou
 * Buy Box) por >6h → status=resolved_auto.
 *
 * Pacing 200ms entre calls = 5 req/s (consistente com shipping-enrich).
 * Pra 140 itens (Vazzo) = ~28s por scan.
 */
@Injectable()
export class ListingPricingScannerService {
  private readonly logger = new Logger(ListingPricingScannerService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned: number
    suggestions_cached: number
    tasks_created: number
    tasks_updated: number
    tasks_resolved_auto: number
    api_calls: number
  }> {
    const t0 = Date.now()
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    // Step 1: lista IDs com sugestão
    let itemsWithSuggestion: string[] = []
    try {
      const { data } = await axios.get(
        `${ML_BASE}/suggestions/user/${sellerId}/items`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
      )
      itemsWithSuggestion = (data?.items ?? []) as string[]
    } catch (err) {
      this.logger.warn(`[pricing-scanner] step1 falhou: ${(err as Error).message}`)
      return { items_scanned: 0, suggestions_cached: 0, tasks_created: 0, tasks_updated: 0, tasks_resolved_auto: 0, api_calls: 1 }
    }

    let cached = 0
    let created = 0
    let updated = 0
    let apiCalls = 1

    // Step 2: price_to_win pra cada item
    for (const itemId of itemsWithSuggestion) {
      try {
        const { data: ptw } = await axios.get(
          `${ML_BASE}/items/${itemId}/price_to_win`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 },
        )
        apiCalls++

        if (!ptw || typeof ptw !== 'object') continue

        // Lookup interno do produto pra calcular margem
        const product = await this.findProduct(orgId, itemId)
        const cost = Number(product?.cost_price ?? 0)
        const minMargin = Number(product?.min_margin_pct ?? 15)

        const currentPrice  = Number(ptw.current_price ?? 0)
        const priceToWin    = Number(ptw.price_to_win ?? currentPrice)
        const isBelowCost   = cost > 0 && priceToWin < cost
        const marginAtSugg  = currentPrice > 0 && cost > 0
          ? Math.round(((priceToWin - cost) / priceToWin) * 10000) / 100
          : null
        const isBelowMin = marginAtSugg != null && marginAtSugg < minMargin

        // Salvar / atualizar cache (rico)
        await this.upsertSuggestionCache({
          organization_id: orgId,
          seller_id: sellerId,
          ml_item_id: itemId,
          product_id: product?.id ?? null,
          current_price: currentPrice,
          suggested_price: priceToWin,
          buy_box_status: ptw.status ?? null,
          visit_share: ptw.visit_share ?? null,
          competitors_sharing: Number(ptw.competitors_sharing_first_place ?? 0),
          consistent: ptw.consistent ?? true,
          reason: Array.isArray(ptw.reason) ? ptw.reason : [],
          catalog_product_id: ptw.catalog_product_id ?? null,
          winner_item_id: ptw.winner?.item_id ?? null,
          winner_price: ptw.winner?.price != null ? Number(ptw.winner.price) : null,
          boosts: ptw.boosts ?? {},
          internal_margin_at_suggested_pct: marginAtSugg,
          is_below_min_margin: isBelowMin,
          is_below_cost: isBelowCost,
          raw_response: ptw,
        })
        cached++

        // Decide tasks pra esse item
        const diffPct = currentPrice > 0
          ? ((currentPrice - priceToWin) / currentPrice) * 100
          : 0

        // Tarefa 1: PRICE_HIGH (preço pode descer)
        if (diffPct >= 5 && !isBelowCost) {
          const result = await this.upsertPriceHighTask(orgId, sellerId, itemId, product?.id ?? null, ptw, {
            currentPrice, priceToWin, diffPct, marginAtSugg, isBelowMin,
          })
          if (result === 'created') created++
          else if (result === 'updated') updated++
        }

        // Tarefa 2: LOSING_BUY_BOX (perdendo ou compartilhando)
        if (ptw.status === 'losing' || (Number(ptw.competitors_sharing_first_place ?? 0) > 0)) {
          const result = await this.upsertLosingBuyBoxTask(orgId, sellerId, itemId, product?.id ?? null, ptw, {
            currentPrice, priceToWin, isBelowMin,
          })
          if (result === 'created') created++
          else if (result === 'updated') updated++
        }
      } catch (err) {
        this.logger.warn(`[pricing-scanner] /items/${itemId}/price_to_win: ${(err as Error).message}`)
      }
      await new Promise(res => setTimeout(res, 200))
    }

    const resolvedAuto = await this.autoResolveStale(orgId, sellerId)

    this.logger.log(
      `[pricing-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `items=${itemsWithSuggestion.length} cached=${cached} ` +
      `created=${created} updated=${updated} resolved=${resolvedAuto} ` +
      `em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned: itemsWithSuggestion.length,
      suggestions_cached: cached,
      tasks_created: created,
      tasks_updated: updated,
      tasks_resolved_auto: resolvedAuto,
      api_calls: apiCalls,
    }
  }

  /** Default min_margin_pct quando produto não tem coluna (não existe ainda
   *  no schema; pode ser adicionada no futuro). */
  private static readonly DEFAULT_MIN_MARGIN_PCT = 15

  private async findProduct(orgId: string, itemId: string): Promise<{ id: string; cost_price: number | null; min_margin_pct: number } | null> {
    // Tenta resolver via product_listings → products
    const { data: pl } = await supabaseAdmin
      .from('product_listings')
      .select('product_id')
      .eq('listing_id', itemId)
      .eq('platform', 'mercadolivre')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    const productId = (pl as { product_id?: string } | null)?.product_id
    if (!productId) return null
    const { data: p } = await supabaseAdmin
      .from('products')
      .select('id, cost_price')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!p) return null
    return {
      id: (p as { id: string }).id,
      cost_price: (p as { cost_price: number | null }).cost_price ?? null,
      min_margin_pct: ListingPricingScannerService.DEFAULT_MIN_MARGIN_PCT,
    }
  }

  private async upsertSuggestionCache(row: Record<string, unknown>): Promise<void> {
    const { error } = await supabaseAdmin
      .from('ml_listing_pricing_suggestions')
      .upsert({ ...row, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() }, {
        onConflict: 'organization_id,seller_id,ml_item_id',
      })
    if (error) this.logger.warn(`[pricing-scanner] cache upsert: ${error.message}`)
  }

  private async upsertPriceHighTask(
    orgId: string,
    sellerId: number,
    itemId: string,
    productId: string | null,
    ptw: { reason?: string[] },
    ctx: { currentPrice: number; priceToWin: number; diffPct: number; marginAtSugg: number | null; isBelowMin: boolean },
  ): Promise<'created' | 'updated' | 'skipped'> {
    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', itemId)
      .eq('task_type', 'PRICE_HIGH')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    const severity = ctx.isBelowMin ? 'low' : (ctx.diffPct >= 20 ? 'high' : ctx.diffPct >= 10 ? 'medium' : 'low')
    const priority = Math.min(100, Math.round(20 + ctx.diffPct * 2))
    const reasonStr = (ptw.reason ?? []).filter(Boolean).join(', ')

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at: new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          severity,
          priority_score: priority,
          current_value: { price: ctx.currentPrice, margin_at_current_pct: null },
          suggested_value: { price: ctx.priceToWin, margin_at_suggested_pct: ctx.marginAtSugg },
          updated_at: new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id: orgId,
      seller_id: sellerId,
      ml_item_id: itemId,
      product_id: productId,
      task_type: 'PRICE_HIGH',
      task_title: `Preço ${ctx.diffPct.toFixed(1)}% acima do sugerido`,
      task_description: `Atual: R$ ${ctx.currentPrice.toFixed(2)} · Sugerido: R$ ${ctx.priceToWin.toFixed(2)}` +
        (reasonStr ? ` · ${reasonStr}` : ''),
      source: 'scanner_pricing',
      severity,
      priority_score: priority,
      impact_area: ['sales', 'exposure'],
      current_value: { price: ctx.currentPrice },
      suggested_value: { price: ctx.priceToWin, margin_at_suggested_pct: ctx.marginAtSugg, warning: ctx.isBelowMin ? 'Margem ficaria abaixo do mínimo' : null },
      suggested_action: ctx.isBelowMin
        ? 'Avaliar — margem ficaria baixa'
        : `Reduzir para R$ ${ctx.priceToWin.toFixed(2)}`,
      deeplink_url: `https://eclick.app.br/dashboard/listings/items/${itemId}`,
      deeplink_module: 'listing_center',
      status: 'open',
    })
    if (error) {
      this.logger.warn(`[pricing-scanner] PRICE_HIGH insert ${itemId}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  private async upsertLosingBuyBoxTask(
    orgId: string,
    sellerId: number,
    itemId: string,
    productId: string | null,
    ptw: { status?: string; competitors_sharing_first_place?: number; visit_share?: string; reason?: string[]; winner?: { price?: number } },
    ctx: { currentPrice: number; priceToWin: number; isBelowMin: boolean },
  ): Promise<'created' | 'updated' | 'skipped'> {
    const competitors = Number(ptw.competitors_sharing_first_place ?? 0)
    const isLosing = ptw.status === 'losing'
    const winnerPrice = ptw.winner?.price != null ? Number(ptw.winner.price) : null

    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', itemId)
      .eq('task_type', 'LOSING_BUY_BOX')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    const severity = isLosing ? 'high' : 'medium'
    const priority = ptw.visit_share === 'low' ? 85 : 65
    const reasonStr = (ptw.reason ?? []).filter(Boolean).join(', ')

    const title = isLosing
      ? (winnerPrice != null
        ? `Perdendo Buy Box · concorrente cobra R$ ${winnerPrice.toFixed(2)}`
        : 'Perdendo Buy Box')
      : `Buy Box compartilhada com ${competitors} competidor${competitors > 1 ? 'es' : ''}`

    const description = `Reduza para R$ ${ctx.priceToWin.toFixed(2)} para ganhar visibilidade` +
      (reasonStr ? `. Motivos: ${reasonStr}` : '') +
      (ptw.visit_share ? ` · Share de visitas: ${ptw.visit_share}` : '')

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
          current_value: { price: ctx.currentPrice, status: ptw.status, visit_share: ptw.visit_share, competitors },
          suggested_value: { price: ctx.priceToWin, target_status: 'winning' },
          updated_at: new Date().toISOString(),
        })
        .eq('id', e.id)
      return 'updated'
    }

    const { error } = await supabaseAdmin.from('ml_listing_tasks').insert({
      organization_id: orgId,
      seller_id: sellerId,
      ml_item_id: itemId,
      product_id: productId,
      task_type: 'LOSING_BUY_BOX',
      task_title: title,
      task_description: description,
      source: 'scanner_pricing',
      severity,
      priority_score: priority,
      impact_area: ['exposure', 'sales'],
      current_value: { price: ctx.currentPrice, status: ptw.status, visit_share: ptw.visit_share, competitors },
      suggested_value: { price: ctx.priceToWin, target_status: 'winning' },
      suggested_action: `Reduzir para R$ ${ctx.priceToWin.toFixed(2)}` +
        (ctx.isBelowMin ? ' (atenção: margem baixa)' : ''),
      deeplink_url: `https://eclick.app.br/dashboard/listings/items/${itemId}`,
      deeplink_module: 'listing_center',
      status: 'open',
    })
    if (error) {
      this.logger.warn(`[pricing-scanner] LOSING_BUY_BOX insert ${itemId}: ${error.message}`)
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
        resolution_notes: 'Sinal não detectado mais (preço/Buy Box ajustados)',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('source', 'scanner_pricing')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')

    if (error) {
      this.logger.warn(`[pricing-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  // ── Helpers chamados por endpoints (apply price) ─────────────────────────

  async getSuggestion(orgId: string, sellerId: number, itemId: string) {
    const { data } = await supabaseAdmin
      .from('ml_listing_pricing_suggestions')
      .select('*')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', itemId)
      .maybeSingle()
    return data
  }

  /** Aplica preço sugerido via PUT /items/{id} no ML. Mode 'safe' valida
   *  margem e bloqueia se abaixo do custo. Force ignora validações. */
  async applyPrice(orgId: string, sellerId: number, itemId: string, mode: 'safe' | 'force' = 'safe', overridePrice?: number): Promise<{
    success: boolean
    new_price: number
    skipped_reason?: string
  }> {
    const sugg = await this.getSuggestion(orgId, sellerId, itemId)
    if (!sugg) throw new Error(`Sugestão não encontrada pra ${itemId} (rode scan/pricing primeiro)`)

    const newPrice = overridePrice ?? Number((sugg as { suggested_price: number }).suggested_price)
    if (mode === 'safe') {
      if ((sugg as { is_below_cost: boolean }).is_below_cost) {
        return { success: false, new_price: newPrice, skipped_reason: 'price_below_cost' }
      }
      if ((sugg as { is_below_min_margin: boolean }).is_below_min_margin) {
        return { success: false, new_price: newPrice, skipped_reason: 'below_min_margin' }
      }
    }

    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    try {
      await axios.put(
        `${ML_BASE}/items/${itemId}`,
        { price: newPrice },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      )
      // Atualiza current_price local
      await supabaseAdmin
        .from('ml_listing_pricing_suggestions')
        .update({ current_price: newPrice, updated_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .eq('ml_item_id', itemId)
      // Resolve tasks abertas desse item desse scanner
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          status: 'resolved_manual',
          resolved_at: new Date().toISOString(),
          resolution_notes: `Preço aplicado: R$ ${newPrice.toFixed(2)}`,
        })
        .eq('organization_id', orgId)
        .eq('seller_id', sellerId)
        .eq('ml_item_id', itemId)
        .eq('source', 'scanner_pricing')
        .eq('status', 'open')
      return { success: true, new_price: newPrice }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string }).response?.data?.message
        ?? (err as Error).message
      throw new Error(`PUT /items/${itemId}: ${msg}`)
    }
  }
}
