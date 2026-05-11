import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Scanner fiscal: detecta NCM, GTIN, ORIGIN, CEST, BRAND, MODEL
 * em items ativos. Cria task FISCAL_DATA_MISSING quando bloqueia NF-e
 * (= NCM, GTIN OU ORIGIN ausentes).
 *
 * Fluxo:
 *  1. Lista /users/{seller}/items/search?status=active (paginado 50/page)
 *  2. Pra cada: GET /items/{id}?attributes=id,attributes,status,title,price
 *  3. Analisa attributes[] → snapshot fiscal completo
 *  4. Upsert no cache + cria task se blocks_nfe
 *
 * Pacing 100ms entre calls (= 10 req/s).
 */
@Injectable()
export class ListingFiscalScannerService {
  private readonly logger = new Logger(ListingFiscalScannerService.name)
  private static readonly REQUIRED_FOR_NFE = ['NCM', 'GTIN', 'ORIGIN'] as const

  constructor(private readonly ml: MercadolivreService) {}

  async scan(orgId: string, sellerId: number): Promise<{
    items_scanned: number
    blocks_nfe_found: number
    tasks_created: number
    tasks_updated: number
    tasks_resolved_auto: number
    api_calls: number
  }> {
    const t0 = Date.now()
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)

    const itemIds = await this.fetchActiveItemIds(token, sellerId)
    let apiCalls = Math.ceil(itemIds.length / 50)

    let blocksNfe = 0
    let created = 0
    let updated = 0

    for (const itemId of itemIds) {
      try {
        const { data: item } = await axios.get(`${ML_BASE}/items/${itemId}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { attributes: 'id,attributes,status,title,price' },
          timeout: 8000,
        })
        apiCalls++

        const fiscal = this.analyzeFiscal(item.attributes ?? [])
        const productId = await this.findProductId(orgId, itemId)

        // Upsert snapshot
        await supabaseAdmin.from('ml_listing_fiscal_snapshots').upsert({
          organization_id: orgId,
          seller_id: sellerId,
          ml_item_id: itemId,
          product_id: productId,
          ...fiscal,
          fetched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id,seller_id,ml_item_id' })

        if (fiscal.blocks_nfe) {
          blocksNfe++
          const result = await this.upsertFiscalTask(orgId, sellerId, itemId, productId, item, fiscal)
          if (result === 'created') created++
          else if (result === 'updated') updated++
        }
      } catch (err) {
        this.logger.warn(`[fiscal-scanner] /items/${itemId}: ${(err as Error).message}`)
      }
      await new Promise(res => setTimeout(res, 100))
    }

    const resolvedAuto = await this.autoResolveFixed(orgId, sellerId)

    this.logger.log(
      `[fiscal-scanner] org=${orgId.slice(0, 8)} seller=${sellerId} ` +
      `items=${itemIds.length} blocks_nfe=${blocksNfe} ` +
      `created=${created} updated=${updated} resolved=${resolvedAuto} ` +
      `em ${Math.round((Date.now() - t0) / 1000)}s`,
    )

    return {
      items_scanned: itemIds.length,
      blocks_nfe_found: blocksNfe,
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
        this.logger.warn(`[fiscal-scanner] search offset=${offset}: ${(err as Error).message}`)
        break
      }
    }
    return ids
  }

  private async findProductId(orgId: string, itemId: string): Promise<string | null> {
    const { data: pl } = await supabaseAdmin
      .from('product_listings')
      .select('product_id')
      .eq('listing_id', itemId)
      .eq('platform', 'mercadolivre')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    return (pl as { product_id?: string | null } | null)?.product_id ?? null
  }

  private analyzeFiscal(attributes: Array<{ id?: string; value_name?: string | null }>): {
    has_ncm: boolean; ncm_value: string | null
    has_gtin: boolean; gtin_value: string | null
    has_origin: boolean; origin_value: string | null
    has_cest: boolean; cest_value: string | null
    has_brand: boolean; brand_value: string | null
    has_model: boolean; model_value: string | null
    fiscal_completeness_score: number
    blocks_nfe: boolean
    missing_fields: string[]
  } {
    const attrMap = new Map<string, string | null>()
    for (const a of attributes) {
      if (a.id) attrMap.set(a.id, a.value_name ?? null)
    }

    const ncm    = attrMap.get('NCM')    ?? null
    const gtin   = attrMap.get('GTIN')   ?? null
    const origin = attrMap.get('ORIGIN') ?? null
    const cest   = attrMap.get('CEST')   ?? null
    const brand  = attrMap.get('BRAND')  ?? null
    const model  = attrMap.get('MODEL')  ?? null

    const has_ncm    = !!ncm    && ncm.trim().length > 0
    const has_gtin   = !!gtin   && gtin.trim().length > 0
    const has_origin = !!origin && origin.trim().length > 0
    const has_cest   = !!cest   && cest.trim().length > 0
    const has_brand  = !!brand  && brand.trim().length > 0
    const has_model  = !!model  && model.trim().length > 0

    const missing: string[] = []
    if (!has_ncm)    missing.push('NCM')
    if (!has_gtin)   missing.push('GTIN')
    if (!has_origin) missing.push('ORIGIN')
    const blocks_nfe = missing.length > 0

    const totalChecks = 6
    const presentCount = [has_ncm, has_gtin, has_origin, has_cest, has_brand, has_model].filter(Boolean).length
    const score = Math.round((presentCount / totalChecks) * 100)

    return {
      has_ncm,    ncm_value:    ncm,
      has_gtin,   gtin_value:   gtin,
      has_origin, origin_value: origin,
      has_cest,   cest_value:   cest,
      has_brand,  brand_value:  brand,
      has_model,  model_value:  model,
      fiscal_completeness_score: score,
      blocks_nfe,
      missing_fields: missing,
    }
  }

  private async upsertFiscalTask(
    orgId: string,
    sellerId: number,
    itemId: string,
    productId: string | null,
    item: { title?: string; price?: number },
    fiscal: { missing_fields: string[]; fiscal_completeness_score: number },
  ): Promise<'created' | 'updated' | 'skipped'> {
    const { data: existing } = await supabaseAdmin
      .from('ml_listing_tasks')
      .select('id, detection_count')
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('ml_item_id', itemId)
      .eq('task_type', 'FISCAL_DATA_MISSING')
      .in('status', ['open', 'snoozed', 'in_progress'])
      .maybeSingle()

    const description = `Falta: ${fiscal.missing_fields.join(', ')}. Bloqueia emissão de NF-e. ` +
      `Score fiscal: ${fiscal.fiscal_completeness_score}/100.`

    if (existing) {
      const e = existing as { id: string; detection_count: number | null }
      await supabaseAdmin
        .from('ml_listing_tasks')
        .update({
          last_seen_at: new Date().toISOString(),
          detection_count: (e.detection_count ?? 1) + 1,
          task_description: description,
          current_value: { missing: fiscal.missing_fields, score: fiscal.fiscal_completeness_score },
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
      task_type: 'FISCAL_DATA_MISSING',
      task_title: 'Dados fiscais incompletos',
      task_description: description,
      source: 'scanner_fiscal',
      severity: 'high',
      priority_score: 75,
      impact_area: ['compliance'],
      current_value: { missing: fiscal.missing_fields, score: fiscal.fiscal_completeness_score },
      suggested_value: { fields_to_fill: fiscal.missing_fields },
      suggested_action: `Preencher ${fiscal.missing_fields.join(', ')} no anúncio ou no produto`,
      deeplink_url: `https://eclick.app.br/dashboard/listings/fiscal`,
      deeplink_module: 'listing_center',
      status: 'open',
    })
    if (error) {
      this.logger.warn(`[fiscal-scanner] insert ${itemId}: ${error.message}`)
      return 'skipped'
    }
    return 'created'
  }

  private async autoResolveFixed(orgId: string, sellerId: number): Promise<number> {
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('ml_listing_tasks')
      .update({
        status: 'resolved_auto',
        resolved_at: new Date().toISOString(),
        resolution_notes: 'Dados fiscais completados (não mais bloqueando NF-e)',
      })
      .eq('organization_id', orgId)
      .eq('seller_id', sellerId)
      .eq('source', 'scanner_fiscal')
      .eq('status', 'open')
      .lt('last_seen_at', sixHoursAgo)
      .select('id')
    if (error) {
      this.logger.warn(`[fiscal-scanner] auto-resolve: ${error.message}`)
      return 0
    }
    return data?.length ?? 0
  }

  // ── Endpoint helpers ────────────────────────────────────────────────────

  async list(orgId: string, opts: { seller_id?: number; blocked_only?: boolean; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
    let q = supabaseAdmin
      .from('ml_listing_fiscal_snapshots')
      .select('*')
      .eq('organization_id', orgId)
    if (opts.seller_id != null) q = q.eq('seller_id', opts.seller_id)
    if (opts.blocked_only)      q = q.eq('blocks_nfe', true)
    q = q.order('fiscal_completeness_score', { ascending: true }).limit(limit)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** Aplica correção fiscal via PUT /items/{id} no ML.
   *  Body: { attributes: [{id: 'NCM', value_name: '...'}, ...] } */
  async fix(orgId: string, sellerId: number, itemId: string, fixes: Array<{ id: string; value_name: string }>): Promise<{ success: boolean }> {
    if (!fixes || fixes.length === 0) throw new Error('fixes vazio')
    const { token } = await this.ml.getTokenForOrg(orgId, sellerId)
    try {
      await axios.put(
        `${ML_BASE}/items/${itemId}`,
        { attributes: fixes },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      )
      // Atualiza snapshot (re-fetch full pra refletir state real)
      try {
        const { data: refreshed } = await axios.get(`${ML_BASE}/items/${itemId}`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { attributes: 'id,attributes' },
          timeout: 8000,
        })
        const fiscal = this.analyzeFiscal(refreshed.attributes ?? [])
        await supabaseAdmin
          .from('ml_listing_fiscal_snapshots')
          .update({ ...fiscal, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('organization_id', orgId).eq('seller_id', sellerId).eq('ml_item_id', itemId)
        // Se passou a não bloquear NF, resolve task aberta
        if (!fiscal.blocks_nfe) {
          await supabaseAdmin
            .from('ml_listing_tasks')
            .update({
              status: 'resolved_manual',
              resolved_at: new Date().toISOString(),
              resolution_notes: `Atributos corrigidos: ${fixes.map(f => f.id).join(', ')}`,
            })
            .eq('organization_id', orgId).eq('seller_id', sellerId).eq('ml_item_id', itemId)
            .eq('task_type', 'FISCAL_DATA_MISSING').eq('status', 'open')
        }
      } catch { /* re-fetch é best-effort */ }
      return { success: true }
    } catch (err) {
      const msg = (err as { response?: { data?: { message?: string } }; message?: string }).response?.data?.message
        ?? (err as Error).message
      throw new Error(`PUT /items/${itemId}: ${msg}`)
    }
  }
}
