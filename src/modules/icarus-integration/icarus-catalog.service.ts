import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { IcarusApiClient, type IcarusProduct } from './icarus-api.client'
import { IcarusIntegrationService } from './icarus-integration.service'
import { computeNetCost, resolveAdjustment, type CostAdjustment, type CostAdjustmentType } from './supplier-cost.util'

/**
 * Sessão 2026-05-18 — Sincronização do catálogo do fornecedor (Cinderella/Icarus).
 *
 * Princípio: NÃO importa o catálogo inteiro automaticamente. O lojista puxa o
 * catálogo do ERP pra uma área de staging (supplier_catalog_items) e escolhe
 * por seleção o que sincronizar. Sincronizar = casar por SKU com um produto
 * existente; se não achar, criar produto novo já vinculado ao fornecedor.
 *
 * Custo: o preço de venda do fornecedor (preco_final) é o preço BRUTO; o custo
 * real (unit_cost) = bruto menos o desconto (geral do fornecedor ou ajuste do
 * produto). Nada é enviado de volta pro ERP — o ajuste é só nosso.
 */

const UPSERT_CHUNK = 500
const SKU_QUERY_CHUNK = 150

export interface DiscountInfo {
  type:  CostAdjustmentType | null
  value: number
}

/** Campos extraídos do payload Pennacorp pra enriquecer um produto. */
interface ProductEnrichment {
  description:       string | null
  category:          string | null
  gtin:              string | null
  weight_kg:         number | null
  height_cm:         number | null
  width_cm:          number | null
  length_cm:         number | null
  image_url:         string | null
  supplier_raw_data: Record<string, unknown>
}

@Injectable()
export class IcarusCatalogService {
  private readonly log = new Logger(IcarusCatalogService.name)

  constructor(
    private readonly client: IcarusApiClient,
    private readonly integration: IcarusIntegrationService,
  ) {}

  // ── Puxar catálogo pro staging ──────────────────────────────────────────

  /** Busca o catálogo do ERP (produtos com saldo) e grava em supplier_catalog_items.
   *  Upsert por (supplier_id, external_code) — preserva sync_status/matched_product_id.
   *  `dtAlteracao` (YYYYMMDD) opcional → puxa só o que mudou desde a data (cron de preço). */
  async pullCatalog(
    orgId: string,
    supplierId: string,
    dtAlteracao?: string,
  ): Promise<{ pulled: number; total: number }> {
    const tok = await this.integration.getDecryptedToken(orgId, supplierId)
    if (!tok) throw new BadRequestException('Integração Icarus não conectada para este fornecedor')

    try {
      const clientConfig = this.integration.buildClientConfig(tok.config)
      const filters: { bSaldo: boolean; dtAlteracao?: string } = { bSaldo: true }
      if (dtAlteracao) filters.dtAlteracao = dtAlteracao
      const res = await this.client.listProducts(tok.access_token, filters, clientConfig)
      const products = res.data ?? []
      const now = new Date().toISOString()

      const rows = products
        .filter(p => p.pt_code != null && String(p.pt_code).trim() !== '')
        .map(p => this.toCatalogRow(orgId, supplierId, tok.integration_id, p, now))

      for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
        const { error } = await supabaseAdmin
          .from('supplier_catalog_items')
          .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'supplier_id,external_code' })
        if (error) throw new BadRequestException(`Falha ao gravar catálogo: ${error.message}`)
      }

      await supabaseAdmin
        .from('supplier_integrations')
        .update({ last_synced_at: now, last_sync_status: 'success', last_sync_error: null, total_synced: rows.length, updated_at: now })
        .eq('id', tok.integration_id)

      this.log.log(`[icarus-catalog] pull supplier=${supplierId} → ${rows.length} itens`)
      return { pulled: rows.length, total: res.total }
    } catch (e) {
      // Registra a falha pra UI (que acompanha por polling) conseguir mostrar.
      await supabaseAdmin
        .from('supplier_integrations')
        .update({
          last_sync_status: 'failed',
          last_sync_error:  ((e as Error).message ?? 'erro desconhecido').slice(0, 500),
          updated_at:       new Date().toISOString(),
        })
        .eq('id', tok.integration_id)
      throw e
    }
  }

  private toCatalogRow(orgId: string, supplierId: string, integrationId: string, p: IcarusProduct, now: string) {
    return {
      organization_id:  orgId,
      supplier_id:      supplierId,
      integration_id:   integrationId,
      external_code:    String(p.pt_code).trim(),
      external_barcode: p.pb_codbar ? String(p.pb_codbar).trim() : null,
      name:             p.pt_descr ?? null,
      family:           p.fa_nome ?? null,
      family_number:    p.fa_number != null && p.fa_number !== '' ? Math.trunc(Number(p.fa_number)) : null,
      unit:             p.pt_unid ?? null,
      image_url:        p.pt_imagem ?? null,
      gross_price:      p.preco_final != null ? Number(p.preco_final) : null,
      original_price:   p.preco_original != null ? Number(p.preco_original) : null,
      promo_active:     String(p.pt_marg_flag ?? '').toUpperCase() === 'T',
      stock:            Number(p.pt_qtd) || 0,
      raw:              p as unknown as Record<string, unknown>,
      last_seen_at:     now,
      updated_at:       now,
    }
  }

  // ── Listagem da tela de sincronização ───────────────────────────────────

  /** Lista itens do staging com status de exibição: synced / available / new. */
  async listCatalog(
    orgId: string,
    supplierId: string,
    opts: { status?: string; search?: string; limit?: number; offset?: number },
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('supplier_catalog_items')
      .select('id, external_code, external_barcode, name, family, image_url, gross_price, original_price, promo_active, stock, sync_status, matched_product_id', { count: 'exact' })
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)

    if (opts.status === 'synced') q = q.eq('sync_status', 'synced')
    else if (opts.status === 'pending') q = q.eq('sync_status', 'pending')

    const search = (opts.search ?? '').replace(/[%,()*]/g, ' ').trim()
    if (search) q = q.or(`external_code.ilike.%${search}%,name.ilike.%${search}%`)

    const { data, error, count } = await q
      .order('name', { ascending: true, nullsFirst: false })
      .range(offset, offset + limit - 1)
    if (error) throw new BadRequestException(error.message)

    const rows = data ?? []
    const pendingCodes = rows.filter(r => r.sync_status !== 'synced').map(r => r.external_code)
    const existingSkus = await this.lookupExistingSkus(orgId, pendingCodes)

    const items = rows.map(r => ({
      ...r,
      display_status: r.sync_status === 'synced'
        ? 'synced'
        : existingSkus.has(r.external_code) ? 'available' : 'new',
    }))
    return { items, total: count ?? 0, limit, offset }
  }

  /** Contagem por status pro cabeçalho da tela. */
  async getCatalogSummary(orgId: string, supplierId: string) {
    const { data, error } = await supabaseAdmin
      .from('supplier_catalog_items')
      .select('external_code, sync_status')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
    if (error) throw new BadRequestException(error.message)

    const all = data ?? []
    const pendingCodes = all.filter(i => i.sync_status !== 'synced').map(i => i.external_code)
    const existingSkus = await this.lookupExistingSkus(orgId, pendingCodes)

    let synced = 0, available = 0, fresh = 0
    for (const i of all) {
      if (i.sync_status === 'synced') synced++
      else if (existingSkus.has(i.external_code)) available++
      else fresh++
    }
    return { total: all.length, synced, available, new: fresh }
  }

  /** Conjunto de SKUs (= external_code) que já existem como produto da org. */
  private async lookupExistingSkus(orgId: string, codes: string[]): Promise<Set<string>> {
    const found = new Set<string>()
    const unique = [...new Set(codes)]
    for (let i = 0; i < unique.length; i += SKU_QUERY_CHUNK) {
      const { data } = await supabaseAdmin
        .from('products')
        .select('sku')
        .eq('organization_id', orgId)
        .in('sku', unique.slice(i, i + SKU_QUERY_CHUNK))
      for (const p of data ?? []) if (p.sku) found.add(p.sku)
    }
    return found
  }

  // ── Sincronizar selecionados ────────────────────────────────────────────

  /** Sincroniza os itens selecionados: casa por SKU (ou cria produto novo) e
   *  gera/atualiza o vínculo em supplier_products com o custo líquido. */
  async syncSelected(orgId: string, supplierId: string, catalogItemIds: string[]) {
    const ids = [...new Set((catalogItemIds ?? []).filter(x => typeof x === 'string' && x))]
    if (ids.length === 0) throw new BadRequestException('Nenhum item selecionado')

    const { data: items, error } = await supabaseAdmin
      .from('supplier_catalog_items')
      .select('*')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)
      .in('id', ids)
    if (error) throw new BadRequestException(error.message)
    if (!items?.length) throw new BadRequestException('Itens do catálogo não encontrados')

    const discount = await this.getSupplierDiscount(orgId, supplierId)
    const supplierDefault: CostAdjustment = { type: discount.type, value: discount.value }

    let created = 0, linked = 0, failed = 0
    const now = new Date().toISOString()

    for (const item of items) {
      try {
        const productId = await this.resolveOrCreateProduct(orgId, supplierId, item)
        if (productId.created) created++; else linked++

        const netCost = computeNetCost(item.gross_price, supplierDefault)
        await this.upsertSupplierProduct(orgId, supplierId, productId.id, item, netCost, now)

        await supabaseAdmin
          .from('supplier_catalog_items')
          .update({ matched_product_id: productId.id, sync_status: 'synced', synced_at: now, updated_at: now })
          .eq('id', item.id)
      } catch (e) {
        failed++
        this.log.warn(`[icarus-catalog] sync item ${item.external_code} falhou: ${(e as Error).message}`)
      }
    }

    return { synced: items.length - failed, created_products: created, linked_existing: linked, failed }
  }

  /** Acha o produto da org pelo SKU; se não houver, cria um rascunho vinculado.
   *  Em ambos os casos enriquece o produto com os dados da Pennacorp. */
  private async resolveOrCreateProduct(
    orgId: string,
    supplierId: string,
    item: Record<string, any>,
  ): Promise<{ id: string; created: boolean }> {
    const enr = this.buildEnrichment(item)

    const { data: existing } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('organization_id', orgId)
      .eq('sku', item.external_code)
      .maybeSingle()
    if (existing) {
      await this.enrichExistingProduct(orgId, existing.id as string, enr)
      return { id: existing.id as string, created: false }
    }

    const { data: novo, error } = await supabaseAdmin
      .from('products')
      .insert({
        organization_id:       orgId,
        name:                  item.name ?? item.external_code,
        sku:                   item.external_code,
        gtin:                  enr.gtin,
        brand:                 'Cinderella Decor',
        photo_urls:            enr.image_url ? [enr.image_url] : [],
        description:           enr.description,
        category:              enr.category,
        weight_kg:             enr.weight_kg,
        height_cm:             enr.height_cm,
        width_cm:              enr.width_cm,
        length_cm:             enr.length_cm,
        supplier_raw_data:     enr.supplier_raw_data,
        status:                'draft',
        condition:             'new',
        preferred_supplier_id: supplierId,
      })
      .select('id')
      .single()
    if (error || !novo) throw new Error(error?.message ?? 'falha ao criar produto')
    return { id: novo.id, created: true }
  }

  /** Extrai os campos de enriquecimento do item do catálogo (payload Pennacorp). */
  private buildEnrichment(item: Record<string, any>): ProductEnrichment {
    const raw = (item.raw ?? {}) as Record<string, any>
    const posNum = (v: unknown): number | null => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    // A Pennacorp envia dimensões em MILÍMETROS; nosso padrão é centímetro.
    const mmToCm = (v: unknown): number | null => {
      const mm = posNum(v)
      return mm == null ? null : Math.round((mm / 10) * 100) / 100
    }
    const text = (v: unknown): string | null => {
      const s = v == null ? '' : String(v).trim()
      return s || null
    }
    return {
      description:       text(raw.pt_obs),
      category:          text(item.family) ?? text(raw.fa_nome),
      gtin:              text(item.external_barcode) ?? text(raw.pb_codbar),
      // Peso já vem em quilos na Pennacorp — sem conversão.
      weight_kg:         posNum(raw.pb_peso) ?? posNum(raw.pt_pesoliq),
      height_cm:         mmToCm(raw.pb_altura),
      width_cm:          mmToCm(raw.pb_largura),
      length_cm:         mmToCm(raw.pb_comprim),
      image_url:         text(item.image_url) ?? text(raw.pt_imagem),
      supplier_raw_data: raw,
    }
  }

  /** Enriquece um produto JÁ existente — preenche só os campos vazios (não
   *  sobrescreve o que o usuário editou). supplier_raw_data é sempre atualizado. */
  private async enrichExistingProduct(
    orgId: string,
    productId: string,
    enr: ProductEnrichment,
  ): Promise<void> {
    const { data: cur } = await supabaseAdmin
      .from('products')
      .select('description, category, gtin, weight_kg, height_cm, width_cm, length_cm, photo_urls')
      .eq('id', productId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!cur) return

    const emptyText = (v: unknown) => v == null || String(v).trim() === ''
    const emptyNum  = (v: unknown) => v == null || Number(v) === 0
    const patch: Record<string, unknown> = {
      supplier_raw_data: enr.supplier_raw_data,
      updated_at:        new Date().toISOString(),
    }
    if (emptyText(cur.description) && enr.description) patch.description = enr.description
    if (emptyText(cur.category)    && enr.category)    patch.category    = enr.category
    if (emptyText(cur.gtin)        && enr.gtin)        patch.gtin        = enr.gtin
    if (emptyNum(cur.weight_kg)    && enr.weight_kg)   patch.weight_kg   = enr.weight_kg
    if (emptyNum(cur.height_cm)    && enr.height_cm)   patch.height_cm   = enr.height_cm
    if (emptyNum(cur.width_cm)     && enr.width_cm)    patch.width_cm    = enr.width_cm
    if (emptyNum(cur.length_cm)    && enr.length_cm)   patch.length_cm   = enr.length_cm
    if ((!Array.isArray(cur.photo_urls) || cur.photo_urls.length === 0) && enr.image_url) {
      patch.photo_urls = [enr.image_url]
    }

    const { error } = await supabaseAdmin
      .from('products')
      .update(patch)
      .eq('id', productId)
      .eq('organization_id', orgId)
    if (error) throw new Error(`falha ao enriquecer produto: ${error.message}`)
  }

  /** Cria ou atualiza o vínculo supplier_products (custo líquido + estoque do parceiro). */
  private async upsertSupplierProduct(
    orgId: string,
    supplierId: string,
    productId: string,
    item: Record<string, any>,
    netCost: number,
    now: string,
  ): Promise<void> {
    const { data: existing } = await supabaseAdmin
      .from('supplier_products')
      .select('id')
      .eq('supplier_id', supplierId)
      .eq('product_id', productId)
      .maybeSingle()

    const row = {
      organization_id:      orgId,
      supplier_id:          supplierId,
      product_id:           productId,
      unit_cost:            netCost,
      supplier_gross_price: item.gross_price,
      supplier_sku:         item.external_code,
      partner_stock:        item.stock ?? 0,
      currency:             'BRL',
      is_active:            true,
      dropship_status:      'active',
      last_sync_at:         now,
      last_cost_change_at:  now,
      last_stock_change_at: now,
      updated_at:           now,
    }

    if (existing) {
      const { error } = await supabaseAdmin.from('supplier_products').update(row).eq('id', existing.id)
      if (error) throw new Error(error.message)
    } else {
      const { error } = await supabaseAdmin.from('supplier_products').insert(row)
      if (error) throw new Error(error.message)
    }

    // Custo líquido e estoque do fornecedor também alimentam o produto.
    await this.syncProductFromSupplier(orgId, productId, {
      cost:  netCost,
      stock: Number(item.stock) || 0,
    })
  }

  /** Espelha dados do fornecedor no produto: CMV (cost_price) e/ou estoque
   *  (stock). Atualiza só os campos informados. */
  private async syncProductFromSupplier(
    orgId: string,
    productId: string,
    fields: { cost?: number; stock?: number },
  ): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (fields.cost != null)  patch.cost_price = fields.cost
    if (fields.stock != null) patch.stock = Math.max(0, Math.round(fields.stock))
    if (Object.keys(patch).length === 0) return
    patch.updated_at = new Date().toISOString()
    const { error } = await supabaseAdmin
      .from('products')
      .update(patch)
      .eq('id', productId)
      .eq('organization_id', orgId)
    if (error) throw new Error(`falha ao atualizar produto: ${error.message}`)
  }

  // ── Desconto / ajuste de custo ──────────────────────────────────────────

  /** Desconto geral do fornecedor (aplica a todo produto sem ajuste próprio). */
  async getSupplierDiscount(orgId: string, supplierId: string): Promise<DiscountInfo> {
    const { data } = await supabaseAdmin
      .from('suppliers')
      .select('default_cost_adjustment_type, default_cost_adjustment_value')
      .eq('id', supplierId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!data) throw new NotFoundException('Fornecedor não encontrado')
    return {
      type:  (data.default_cost_adjustment_type as CostAdjustmentType | null) ?? null,
      value: Number(data.default_cost_adjustment_value) || 0,
    }
  }

  /** Define o desconto geral e recalcula o custo de todos os produtos do fornecedor. */
  async setSupplierDiscount(orgId: string, supplierId: string, type: CostAdjustmentType | null, value: number) {
    if (type && type !== 'percent' && type !== 'fixed') {
      throw new BadRequestException('Desconto geral aceita apenas percent ou fixed')
    }
    const { error } = await supabaseAdmin
      .from('suppliers')
      .update({
        default_cost_adjustment_type:  type,
        default_cost_adjustment_value: Number(value) || 0,
        updated_at:                    new Date().toISOString(),
      })
      .eq('id', supplierId)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(error.message)

    const recomputed = await this.recomputeSupplierCosts(orgId, supplierId)
    return { ok: true, recomputed }
  }

  /** Ajuste de custo de um produto específico (percent/fixed/override ou null = usa o geral). */
  async setProductAdjustment(
    orgId: string,
    supplierProductId: string,
    type: CostAdjustmentType | null,
    value: number | null,
  ) {
    if (type && type !== 'percent' && type !== 'fixed' && type !== 'override') {
      throw new BadRequestException('Ajuste inválido')
    }
    const { data: sp } = await supabaseAdmin
      .from('supplier_products')
      .select('id, supplier_id, product_id, supplier_gross_price')
      .eq('id', supplierProductId)
      .eq('organization_id', orgId)
      .maybeSingle()
    if (!sp) throw new NotFoundException('Vínculo de produto não encontrado')

    const discount = await this.getSupplierDiscount(orgId, sp.supplier_id)
    const adj = resolveAdjustment(
      { type, value },
      { type: discount.type, value: discount.value },
    )
    const netCost = computeNetCost(Number(sp.supplier_gross_price) || 0, adj)
    const now = new Date().toISOString()

    const { error } = await supabaseAdmin
      .from('supplier_products')
      .update({
        cost_adjustment_type:  type,
        cost_adjustment_value: type ? (Number(value) || 0) : null,
        unit_cost:             netCost,
        last_cost_change_at:   now,
        updated_at:            now,
      })
      .eq('id', supplierProductId)
    if (error) throw new BadRequestException(error.message)

    await this.syncProductFromSupplier(orgId, sp.product_id as string, { cost: netCost })
    return { ok: true, unit_cost: netCost }
  }

  /** Recalcula unit_cost de todos os vínculos do fornecedor. Retorna quantos mudaram. */
  async recomputeSupplierCosts(orgId: string, supplierId: string): Promise<number> {
    const discount = await this.getSupplierDiscount(orgId, supplierId)
    const supplierDefault: CostAdjustment = { type: discount.type, value: discount.value }

    const { data: sps } = await supabaseAdmin
      .from('supplier_products')
      .select('id, product_id, supplier_gross_price, cost_adjustment_type, cost_adjustment_value, unit_cost')
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)

    let changed = 0
    const now = new Date().toISOString()
    for (const sp of sps ?? []) {
      if (sp.supplier_gross_price == null) continue
      const adj = resolveAdjustment(
        { type: (sp.cost_adjustment_type as CostAdjustmentType | null) ?? null, value: sp.cost_adjustment_value ?? null },
        supplierDefault,
      )
      const newCost = computeNetCost(Number(sp.supplier_gross_price), adj)
      if (Number(sp.unit_cost) !== newCost) {
        await supabaseAdmin
          .from('supplier_products')
          .update({ unit_cost: newCost, last_cost_change_at: now, updated_at: now })
          .eq('id', sp.id)
        await this.syncProductFromSupplier(orgId, sp.product_id as string, { cost: newCost })
        changed++
      }
    }
    return changed
  }

  /** Produtos já vinculados ao fornecedor — pra tela de ajuste por produto.
   *  Paginado (limit/offset) e com busca opcional por nome do produto. */
  async listSyncedProducts(
    orgId: string,
    supplierId: string,
    opts: { limit?: number; offset?: number; search?: string } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
    const offset = Math.max(opts.offset ?? 0, 0)

    let q = supabaseAdmin
      .from('supplier_products')
      .select(
        'id, product_id, supplier_sku, supplier_gross_price, cost_adjustment_type, cost_adjustment_value, unit_cost, partner_stock, products!inner(name, sku)',
        { count: 'exact' },
      )
      .eq('organization_id', orgId)
      .eq('supplier_id', supplierId)

    const search = (opts.search ?? '').replace(/[%,()*]/g, ' ').trim()
    if (search) q = q.or(`supplier_sku.ilike.%${search}%,products.name.ilike.%${search}%`)

    const { data, error, count } = await q
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) throw new BadRequestException(error.message)

    const items = (data ?? []).map(sp => {
      const prod = Array.isArray(sp.products) ? sp.products[0] : sp.products
      return {
        id:                    sp.id,
        product_id:            sp.product_id,
        name:                  prod?.name ?? null,
        sku:                   prod?.sku ?? sp.supplier_sku,
        supplier_gross_price:  sp.supplier_gross_price,
        cost_adjustment_type:  sp.cost_adjustment_type,
        cost_adjustment_value: sp.cost_adjustment_value,
        unit_cost:             sp.unit_cost,
        partner_stock:         sp.partner_stock,
      }
    })
    return { items, total: count ?? 0, limit, offset }
  }
}
