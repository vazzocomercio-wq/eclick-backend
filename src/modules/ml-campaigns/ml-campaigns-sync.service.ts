/** Sync principal do F8 Campaign Center.
 *
 *  Estrategia em 2 fases (validada no smoke test):
 *
 *  FASE A — Lista campanhas e items (barato):
 *    1. /seller-promotions/users/:id  -> N campanhas
 *    2. Pra cada campanha, /promotions/:id/items?status=candidate
 *       e ?status=started (pending eh raro)
 *    3. UPSERT campanhas + items, calcula health check
 *
 *  FASE B — Enriquece subsidio MELI (so candidates):
 *    1. Pra cada candidate distinto, /seller-promotions/items/:id
 *    2. Extrai meli_percentage/seller_percentage da promocao matching
 *    3. UPDATE no item com subsidio + agregados na campanha
 *
 *  Throttling: 5 req/sec entre chamadas pra nao trigger 429.
 *
 *  Multi-conta: opcional `sellerId` filtra; sem ele faz fan-out via
 *  getAllTokensForOrg (mesma estrategia do F7).
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { MlCampaignsApiClient, CampaignsRateLimitedException } from './ml-campaigns-api.client'
import type {
  MlPromotionListItem,
  MlPromotionItem,
  MlItemPromotion,
  MlCampaignsSyncResult,
  HealthAssessment,
  MlPromotionType,
  MlCampaignStatus,
  MlItemStatus,
} from './ml-campaigns.types'

interface SyncOpts {
  sellerId?: number
}

@Injectable()
export class MlCampaignsSyncService {
  private readonly logger = new Logger(MlCampaignsSyncService.name)

  constructor(
    private readonly ml:     MercadolivreService,
    private readonly client: MlCampaignsApiClient,
  ) {}

  /** Sync principal — fan-out se sellerId omitido.
   *  Pode demorar ~5min com 1500+ items + Fase B de subsidio.
   *  Por isso usa fire-and-forget quando chamado via syncOrgAsync(). */
  async syncOrg(orgId: string, opts: SyncOpts = {}): Promise<MlCampaignsSyncResult> {
    const t0 = Date.now()
    const tokens = opts.sellerId != null
      ? [await this.ml.getTokenForOrg(orgId, opts.sellerId)]
      : await this.ml.getAllTokensForOrg(orgId).catch(() => [])

    if (tokens.length === 0) throw new BadRequestException('ML nao conectado pra esta org')

    const { data: log, error: logErr } = await supabaseAdmin
      .from('ml_campaigns_sync_logs')
      .insert({
        organization_id: orgId,
        seller_id:       opts.sellerId ?? null,
        sync_type:       'full',
        status:          'running',
      })
      .select('id')
      .single()
    if (logErr || !log) throw new BadRequestException(`falha ao criar sync log: ${logErr?.message}`)

    const stats = {
      campaigns_processed:    0,
      items_processed:        0,
      items_subsidy_enriched: 0,
      api_calls_count:        0,
      pages_fetched:          0,
    }

    try {
      for (const t of tokens) {
        const r = await this.syncSeller(orgId, t.token, t.sellerId)
        stats.campaigns_processed    += r.campaigns
        stats.items_processed        += r.items
        stats.items_subsidy_enriched += r.enriched
        stats.api_calls_count        += r.calls
        stats.pages_fetched          += r.pages
      }

      // Recompute summary por seller
      for (const t of tokens) {
        await this.recomputeSummary(orgId, t.sellerId)
      }

      const duration = Math.round((Date.now() - t0) / 1000)
      await supabaseAdmin
        .from('ml_campaigns_sync_logs')
        .update({
          ...stats,
          status:           'completed',
          duration_seconds: duration,
          completed_at:     new Date().toISOString(),
        })
        .eq('id', log.id)

      return { log_id: log.id, ...stats, duration_seconds: duration }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await supabaseAdmin
        .from('ml_campaigns_sync_logs')
        .update({
          status:           e instanceof CampaignsRateLimitedException ? 'partial' : 'failed',
          error_message:    msg,
          duration_seconds: Math.round((Date.now() - t0) / 1000),
          completed_at:     new Date().toISOString(),
          ...stats,
        })
        .eq('id', log.id)
      throw e
    }
  }

  /** Kick off sync em background — retorna o log_id imediatamente.
   *  Resolve o problema de Railway HTTP timeout em syncs longos (5min+).
   *  Frontend polla /sync/logs pra ver progresso. */
  async syncOrgAsync(orgId: string, opts: SyncOpts = {}): Promise<{ log_id: string; status: string }> {
    // Cria o log primeiro pra ter ID. Status 'running' (constraint nao
    // permite 'pending'). Background atualiza pra completed/failed.
    const { data: log, error: logErr } = await supabaseAdmin
      .from('ml_campaigns_sync_logs')
      .insert({
        organization_id: orgId,
        seller_id:       opts.sellerId ?? null,
        sync_type:       'full',
        status:          'running',
        started_at:      new Date().toISOString(),
      })
      .select('id')
      .single()
    if (logErr || !log) throw new BadRequestException(`falha ao criar sync log: ${logErr?.message}`)
    const logId = (log as { id: string }).id

    // Disparar sync em background — NAO await
    setImmediate(() => {
      void this.runBackgroundSync(orgId, opts, logId).catch(e => {
        this.logger.error(`[sync] background falhou log=${logId}: ${(e as Error).message}`)
      })
    })

    return { log_id: logId, status: 'running' }
  }

  /** Wrapper que atualiza o log existente em vez de criar novo. */
  private async runBackgroundSync(orgId: string, opts: SyncOpts, logId: string): Promise<void> {
    const t0 = Date.now()
    const tokens = opts.sellerId != null
      ? [await this.ml.getTokenForOrg(orgId, opts.sellerId).catch(() => null)].filter(Boolean) as Array<{ token: string; sellerId: number }>
      : await this.ml.getAllTokensForOrg(orgId).catch(() => [])

    if (tokens.length === 0) {
      await supabaseAdmin
        .from('ml_campaigns_sync_logs')
        .update({ status: 'failed', error_message: 'ML nao conectado', completed_at: new Date().toISOString() })
        .eq('id', logId)
      return
    }

    const stats = {
      campaigns_processed:    0,
      items_processed:        0,
      items_subsidy_enriched: 0,
      api_calls_count:        0,
      pages_fetched:          0,
    }

    try {
      for (const t of tokens) {
        const r = await this.syncSeller(orgId, t.token, t.sellerId)
        stats.campaigns_processed    += r.campaigns
        stats.items_processed        += r.items
        stats.items_subsidy_enriched += r.enriched
        stats.api_calls_count        += r.calls
        stats.pages_fetched          += r.pages
      }

      for (const t of tokens) {
        await this.recomputeSummary(orgId, t.sellerId)
      }

      const duration = Math.round((Date.now() - t0) / 1000)
      await supabaseAdmin
        .from('ml_campaigns_sync_logs')
        .update({
          ...stats,
          status:           'completed',
          duration_seconds: duration,
          completed_at:     new Date().toISOString(),
        })
        .eq('id', logId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.logger.error(`[sync] erro background ${logId}: ${msg}`)
      await supabaseAdmin
        .from('ml_campaigns_sync_logs')
        .update({
          status:           e instanceof CampaignsRateLimitedException ? 'partial' : 'failed',
          error_message:    msg,
          duration_seconds: Math.round((Date.now() - t0) / 1000),
          completed_at:     new Date().toISOString(),
          ...stats,
        })
        .eq('id', logId)
    }
  }

  private async syncSeller(orgId: string, token: string, sellerId: number) {
    const stats = { campaigns: 0, items: 0, enriched: 0, calls: 0, pages: 0 }

    // ── Fase A: lista campanhas + items ──────────────────────────
    let campaigns: MlPromotionListItem[]
    try {
      campaigns = await this.client.listSellerPromotions(token, sellerId)
      stats.calls++
    } catch (e) {
      this.logger.warn(`[campaigns] listSellerPromotions falhou seller=${sellerId}: ${(e as Error).message}`)
      return stats
    }

    // UPSERT campanhas
    for (const c of campaigns) {
      await this.upsertCampaign(orgId, sellerId, c)
      stats.campaigns++
    }

    // Pra cada campanha, lista items por status (candidate + started)
    for (const c of campaigns) {
      const campaignRow = await this.findCampaignRow(orgId, sellerId, c.id)
      if (!campaignRow) continue

      for (const status of ['candidate', 'started'] as const) {
        const result = await this.syncCampaignItemsByStatus(
          orgId, sellerId, token, campaignRow.id, c.id, c.type, status,
        )
        stats.items += result.items
        stats.calls += result.calls
        stats.pages += result.pages
      }

      // Atualiza contadores na campanha
      await this.updateCampaignCounters(campaignRow.id)
    }

    // ── Fase B: enriquece subsidio em candidates ─────────────────
    const enriched = await this.enrichCandidatesSubsidy(orgId, sellerId, token)
    stats.enriched += enriched.enriched
    stats.calls    += enriched.calls

    // ── Fase C: enriquece metadata visual (thumbnail/title) ─────
    const metaResult = await this.enrichItemsMetadata(orgId, sellerId, token)
    stats.calls += metaResult.calls

    return stats
  }

  /** Fire-and-forget: dispara enrichItemsMetadata em background.
   *  Retorna imediatamente { items_pending, started: bool }. */
  async enrichMetadataAsync(orgId: string, sellerId?: number): Promise<{ items_pending: number; started: boolean }> {
    let q = supabaseAdmin
      .from('ml_campaign_items')
      .select('ml_item_id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('thumbnail_url', null)
    if (sellerId != null) q = q.eq('seller_id', sellerId)
    const { count } = await q
    const pending = count ?? 0

    if (pending === 0) return { items_pending: 0, started: false }

    setImmediate(() => {
      void (async () => {
        try {
          const tokens = sellerId != null
            ? [await this.ml.getTokenForOrg(orgId, sellerId).catch(() => null)].filter(Boolean) as Array<{ token: string; sellerId: number }>
            : await this.ml.getAllTokensForOrg(orgId).catch(() => [])
          for (const t of tokens) {
            await this.enrichItemsMetadata(orgId, t.sellerId, t.token).catch(e =>
              this.logger.warn(`[enrich-async] seller=${t.sellerId} falhou: ${(e as Error).message}`),
            )
          }
        } catch (e) {
          this.logger.warn(`[enrich-async] erro: ${(e as Error).message}`)
        }
      })()
    })

    return { items_pending: pending, started: true }
  }

  /** Fase C: pra cada item sem thumbnail_url, faz batch /items?ids=X
   *  pra pegar thumbnail/title/permalink. Cap de 200 items por sync
   *  pra nao consumir muito API. Throttle 1 batch/segundo. */
  private async enrichItemsMetadata(
    orgId: string, sellerId: number, token: string,
  ): Promise<{ enriched: number; calls: number }> {
    const { data: rows } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('ml_item_id')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .is('thumbnail_url',   null)
      .limit(200)

    if (!rows || rows.length === 0) return { enriched: 0, calls: 0 }

    // Distinct items (1 ml_item_id pode estar em N campanhas)
    const distinctIds = [...new Set((rows as Array<{ ml_item_id: string }>).map(r => r.ml_item_id))]

    let enriched = 0, calls = 0
    for (let i = 0; i < distinctIds.length; i += 20) {
      const batch = distinctIds.slice(i, i + 20)
      try {
        const items = await this.client.getItemsMetadata(token, sellerId, batch)
        calls++

        // Upgrade — UPDATE all rows com esse ml_item_id (1 item × N campanhas)
        for (const it of items) {
          if (!it.thumbnail && !it.title && !it.permalink) continue
          await supabaseAdmin
            .from('ml_campaign_items')
            .update({
              thumbnail_url:           it.thumbnail ?? null,
              title:                   it.title ?? null,
              permalink:               it.permalink ?? null,
              last_metadata_synced_at: new Date().toISOString(),
            })
            .eq('organization_id', orgId)
            .eq('seller_id',       sellerId)
            .eq('ml_item_id',      it.id)
          enriched++
        }
      } catch (e) {
        this.logger.warn(`[campaigns] getItemsMetadata batch falhou: ${(e as Error).message}`)
      }
      // Throttle 1 req/sec
      if (i + 20 < distinctIds.length) await this.sleep(1000)
    }

    return { enriched, calls }
  }

  /** Sync items de 1 campanha em 1 status, com paginacao search_after.
   *  DEFENSIVO: ML retorna shapes diferentes — { results: [...] }, array
   *  direto, ou nada. Falhas em items individuais nao param a paginacao. */
  private async syncCampaignItemsByStatus(
    orgId:         string,
    sellerId:      number,
    token:         string,
    campaignRowId: string,
    mlCampaignId:  string,
    promotionType: MlPromotionType,
    status:        'candidate' | 'started',
  ): Promise<{ items: number; calls: number; pages: number }> {
    let items = 0, calls = 0, pages = 0
    let searchAfter: string | undefined
    const MAX_PAGES = 100  // safety

    do {
      let resp: any
      try {
        resp = await this.client.listCampaignItems(token, sellerId, mlCampaignId, promotionType, {
          status, searchAfter, limit: 50,
        })
        calls++
        pages++
      } catch (e) {
        this.logger.warn(`[campaigns] listCampaignItems falhou ${mlCampaignId}/${status}: ${(e as Error).message}`)
        break
      }

      // Normaliza shape: ML as vezes retorna { results: [...] }, as vezes
      // array direto, as vezes null. Tudo isso vira [] vazio.
      const results: MlPromotionItem[] = Array.isArray(resp?.results)
        ? resp.results
        : Array.isArray(resp)
          ? resp
          : []

      for (const item of results) {
        try {
          await this.upsertItem(orgId, sellerId, campaignRowId, mlCampaignId, promotionType, item, status)
          items++
        } catch (e) {
          this.logger.warn(`[campaigns] upsert item ${(item as any)?.id} falhou: ${(e as Error).message}`)
        }
      }

      searchAfter = resp?.paging?.searchAfter ?? resp?.paging?.search_after
      if (!searchAfter || results.length === 0) break
      if (pages >= MAX_PAGES) {
        this.logger.warn(`[campaigns] MAX_PAGES atingido pra ${mlCampaignId}/${status}`)
        break
      }
      // Throttle leve entre paginas
      await this.sleep(250)
    } while (true)

    return { items, calls, pages }
  }

  /** Fase B: pra cada candidate distinto, busca subsidio MELI via
   *  /seller-promotions/items/:itemId. Throttled em 5 req/sec. */
  private async enrichCandidatesSubsidy(
    orgId: string, sellerId: number, token: string,
  ): Promise<{ enriched: number; calls: number }> {
    // Pega items distintos (org+seller) que sao candidates e ainda nao tem
    // subsidio sincado (ou foi ha mais de 1h)
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString()
    const { data: rows, error } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('id, ml_item_id, ml_campaign_id')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('status',          'candidate')
      .or(`last_subsidy_synced_at.is.null,last_subsidy_synced_at.lt.${cutoff}`)
    if (error || !rows) return { enriched: 0, calls: 0 }

    // Agrupa por item — 1 chamada item retorna TODAS as promocoes daquele item
    const byItem = new Map<string, Array<{ id: string; ml_campaign_id: string }>>()
    for (const r of rows) {
      const arr = byItem.get(r.ml_item_id) ?? []
      arr.push({ id: r.id, ml_campaign_id: r.ml_campaign_id })
      byItem.set(r.ml_item_id, arr)
    }

    let enriched = 0, calls = 0
    const items = [...byItem.entries()]

    for (let i = 0; i < items.length; i++) {
      const [itemId, dbRows] = items[i]!
      let promotions: MlItemPromotion[]
      try {
        promotions = await this.client.listItemPromotions(token, sellerId, itemId)
        calls++
      } catch (e) {
        this.logger.warn(`[campaigns] listItemPromotions falhou ${itemId}: ${(e as Error).message}`)
        continue
      }

      // Casa cada DB row com a promocao matching e atualiza subsidio
      for (const dbRow of dbRows) {
        const promo = promotions.find(p => p.id === dbRow.ml_campaign_id)
        if (!promo) continue

        const meliPct   = promo.meli_percentage   ?? null
        const sellerPct = promo.seller_percentage ?? null
        const hasSubsidy = (meliPct ?? 0) > 0

        const update: Record<string, unknown> = {
          meli_percentage:        meliPct,
          seller_percentage:      sellerPct,
          has_meli_subsidy:       hasSubsidy,
          last_subsidy_synced_at: new Date().toISOString(),
        }
        // Se ML sugeriu preco com subsidio, calculamos R$ exato
        if (promo.price != null && promo.original_price != null && meliPct != null) {
          const totalDiscount = promo.original_price - promo.price
          // Aproximacao: meli_amount = totalDiscount × (meliPct / (meliPct + sellerPct))
          const denom = (meliPct + (sellerPct ?? 0)) || 1
          const meliAmount = totalDiscount * (meliPct / denom)
          update.meli_subsidy_amount = Number(meliAmount.toFixed(2))
          update.seller_pays_amount  = Number((totalDiscount - meliAmount).toFixed(2))
        }

        await supabaseAdmin
          .from('ml_campaign_items')
          .update(update)
          .eq('id', dbRow.id)
        enriched++
      }

      // Throttle 5 req/sec
      if (i < items.length - 1) await this.sleep(200)
    }

    return { enriched, calls }
  }

  // ── UPSERT helpers ────────────────────────────────────────────────

  private async upsertCampaign(orgId: string, sellerId: number, c: MlPromotionListItem) {
    const payload = {
      organization_id:    orgId,
      seller_id:          sellerId,
      ml_campaign_id:     c.id,
      ml_promotion_type:  c.type,
      name:               c.name ?? null,
      start_date:         c.start_date ?? null,
      finish_date:        c.finish_date ?? null,
      deadline_date:      c.deadline_date ?? null,
      status:             c.status,
      raw_response:       c as unknown,
      last_synced_at:     new Date().toISOString(),
    }

    const { error } = await supabaseAdmin
      .from('ml_campaigns')
      .upsert(payload, { onConflict: 'organization_id,seller_id,ml_campaign_id' })
    if (error) this.logger.warn(`[campaigns] upsert campanha ${c.id} falhou: ${error.message}`)
  }

  private async upsertItem(
    orgId:         string,
    sellerId:      number,
    campaignRowId: string,
    mlCampaignId:  string,
    promotionType: MlPromotionType,
    it:            MlPromotionItem,
    status:        MlItemStatus,
  ) {
    // Lookup product interno via product_listings (listing_id = ml_item_id).
    // Filtra por platform='ML' e cruza com products.organization_id pra
    // garantir org match (product_listings nao tem organization_id direto).
    const { data: listingRow } = await supabaseAdmin
      .from('product_listings')
      .select('product_id, products!inner(organization_id)')
      .eq('listing_id', it.id)
      .eq('platform',   'ML')
      .eq('products.organization_id', orgId)
      .limit(1)
      .maybeSingle()
    const productId = (listingRow as { product_id: string } | null)?.product_id ?? null

    // Health check
    const health = await this.assessHealth(productId)

    const payload = {
      organization_id:             orgId,
      seller_id:                   sellerId,
      campaign_id:                 campaignRowId,
      product_id:                  productId,
      ml_item_id:                  it.id,
      ml_campaign_id:              mlCampaignId,
      ml_promotion_type:           promotionType,
      ref_id:                      it.ref_id ?? null,
      status,
      original_price:              it.original_price ?? null,
      current_price:               it.price ?? null,
      suggested_discounted_price:  it.suggested_discounted_price ?? null,
      min_discounted_price:        it.min_discounted_price ?? null,
      max_discounted_price:        it.max_discounted_price ?? null,
      max_top_discounted_price:    it.max_top_discounted_price ?? null,
      min_quantity:                it.stock?.min ?? null,
      max_quantity:                it.stock?.max ?? null,
      has_cost_data:               health.has_cost_data,
      has_tax_data:                health.has_tax_data,
      has_dimensions:              health.has_dimensions,
      health_status:               health.status,
      health_warnings:             health.warnings,
      raw_response:                it as unknown,
      last_synced_at:              new Date().toISOString(),
    }

    const { error } = await supabaseAdmin
      .from('ml_campaign_items')
      .upsert(payload, { onConflict: 'campaign_id,ml_item_id' })
    if (error) this.logger.warn(`[campaigns] upsert item ${it.id} falhou: ${error.message}`)
  }

  private async assessHealth(productId: string | null): Promise<HealthAssessment> {
    if (!productId) {
      return {
        status: 'incomplete',
        has_cost_data:  false,
        has_tax_data:   false,
        has_dimensions: false,
        warnings: [{ code: 'no_internal_product', message: 'Anuncio sem produto interno vinculado' }],
      }
    }

    const { data: p } = await supabaseAdmin
      .from('products')
      .select('cost_price, tax_percentage, weight_kg, width_cm, height_cm, length_cm')
      .eq('id', productId)
      .maybeSingle()

    if (!p) {
      return {
        status: 'incomplete',
        has_cost_data:  false,
        has_tax_data:   false,
        has_dimensions: false,
        warnings: [{ code: 'product_not_found', message: 'Produto interno nao encontrado' }],
      }
    }

    const prod = p as {
      cost_price:     number | null
      tax_percentage: number | null
      weight_kg:      number | null
      width_cm:       number | null
      height_cm:      number | null
      length_cm:      number | null
    }

    const has_cost = (prod.cost_price ?? 0) > 0
    const has_tax  = prod.tax_percentage != null && prod.tax_percentage >= 0
    const has_dim  = (prod.weight_kg ?? 0) > 0
                  && (prod.width_cm  ?? 0) > 0
                  && (prod.height_cm ?? 0) > 0
                  && (prod.length_cm ?? 0) > 0

    const warnings: Array<{ code: string; message: string }> = []
    if (!has_cost) warnings.push({ code: 'missing_cost',       message: 'Custo nao cadastrado' })
    if (!has_tax)  warnings.push({ code: 'missing_tax',        message: 'Imposto nao cadastrado' })
    if (!has_dim)  warnings.push({ code: 'missing_dimensions', message: 'Dimensoes incompletas' })

    let status: HealthAssessment['status']
    if (warnings.length === 0)            status = 'ready'
    else if (!has_cost)                   status = 'missing_cost'
    else if (!has_tax)                    status = 'missing_tax'
    else if (!has_dim)                    status = 'missing_shipping'
    else                                   status = 'incomplete'

    return {
      status,
      has_cost_data:  has_cost,
      has_tax_data:   has_tax,
      has_dimensions: has_dim,
      warnings,
    }
  }

  // ── Aggregations ──────────────────────────────────────────────────

  private async findCampaignRow(orgId: string, sellerId: number, mlCampaignId: string) {
    const { data } = await supabaseAdmin
      .from('ml_campaigns')
      .select('id')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)
      .eq('ml_campaign_id',  mlCampaignId)
      .maybeSingle()
    return data as { id: string } | null
  }

  private async updateCampaignCounters(campaignRowId: string) {
    const { data: items } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('status, has_meli_subsidy, meli_percentage')
      .eq('campaign_id', campaignRowId)

    const arr = (items ?? []) as Array<{ status: string; has_meli_subsidy: boolean; meli_percentage: number | null }>
    const counters = {
      candidate_count:           arr.filter(i => i.status === 'candidate').length,
      pending_count:             arr.filter(i => i.status === 'pending').length,
      started_count:             arr.filter(i => i.status === 'started').length,
      finished_count:            arr.filter(i => i.status === 'finished').length,
      items_with_subsidy_count:  arr.filter(i => i.has_meli_subsidy).length,
    }
    const subsidyItems = arr.filter(i => i.has_meli_subsidy && i.meli_percentage != null)
    const avgSubsidy = subsidyItems.length > 0
      ? subsidyItems.reduce((s, i) => s + (i.meli_percentage ?? 0), 0) / subsidyItems.length
      : null

    await supabaseAdmin
      .from('ml_campaigns')
      .update({
        ...counters,
        has_subsidy_items:    subsidyItems.length > 0,
        avg_meli_subsidy_pct: avgSubsidy != null ? Number(avgSubsidy.toFixed(2)) : null,
      })
      .eq('id', campaignRowId)
  }

  /** Recompute summary executivo (1 row org+seller) */
  async recomputeSummary(orgId: string, sellerId: number): Promise<void> {
    // Campanhas
    const { data: campaigns } = await supabaseAdmin
      .from('ml_campaigns')
      .select('status, deadline_date')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)

    const today      = new Date()
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate())
    const todayEnd   = new Date(todayStart.getTime() + 86_400_000)
    const weekEnd    = new Date(todayStart.getTime() + 7 * 86_400_000)

    const campArr = (campaigns ?? []) as Array<{ status: string; deadline_date: string | null }>
    const campSummary = {
      total_active_campaigns:  campArr.filter(c => c.status === 'started').length,
      total_pending_campaigns: campArr.filter(c => c.status === 'pending').length,
      total_ending_today:      campArr.filter(c => c.deadline_date && new Date(c.deadline_date) >= todayStart && new Date(c.deadline_date) < todayEnd).length,
      total_ending_this_week:  campArr.filter(c => c.deadline_date && new Date(c.deadline_date) >= todayStart && new Date(c.deadline_date) < weekEnd).length,
    }

    // Items
    const { data: items } = await supabaseAdmin
      .from('ml_campaign_items')
      .select('status, health_status, has_meli_subsidy, meli_subsidy_amount, original_price, current_price')
      .eq('organization_id', orgId)
      .eq('seller_id',       sellerId)

    const itemArr = (items ?? []) as Array<{
      status:               string
      health_status:        string | null
      has_meli_subsidy:     boolean
      meli_subsidy_amount:  number | null
      original_price:       number | null
      current_price:        number | null
    }>

    const itemSummary = {
      total_candidate_items:         itemArr.filter(i => i.status === 'candidate').length,
      total_pending_items:           itemArr.filter(i => i.status === 'pending').length,
      total_participating_items:     itemArr.filter(i => i.status === 'started').length,
      items_missing_cost:            itemArr.filter(i => i.health_status === 'missing_cost' || i.health_status === 'incomplete').length,
      items_missing_tax:             itemArr.filter(i => i.health_status === 'missing_tax').length,
      items_health_ok:               itemArr.filter(i => i.health_status === 'ready').length,
      total_meli_subsidy_available:  itemArr
        .filter(i => i.has_meli_subsidy)
        .reduce((s, i) => s + (i.meli_subsidy_amount ?? 0), 0),
    }

    const { error } = await supabaseAdmin
      .from('ml_campaigns_summary')
      .upsert({
        organization_id: orgId,
        seller_id:       sellerId,
        ...campSummary,
        ...itemSummary,
        last_sync_at:    new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      }, { onConflict: 'organization_id,seller_id' })
    if (error) this.logger.warn(`[campaigns] recomputeSummary falhou: ${error.message}`)
  }

  private sleep(ms: number) {
    return new Promise<void>(r => setTimeout(r, ms))
  }
}
