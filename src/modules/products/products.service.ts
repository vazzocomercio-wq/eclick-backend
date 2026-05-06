import { Injectable, NotFoundException, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'

const PRODUCT_FIELDS = `id,name,sku,brand,price,stock,status,platforms,photo_urls,
  ml_title,condition,category,created_at,
  wholesale_enabled,wholesale_levels,ml_listing_type,
  ml_free_shipping,ml_flex,ml_item_id,ml_listing_id,ml_permalink,cost_price,tax_percentage,tax_on_freight`

export interface UpdateProductCostsDto {
  cost_price?:    number | null
  tax_percentage?: number | null
  tax_on_freight?: boolean
}

export interface CreateVinculoDto {
  product_id:           string
  platform?:            string
  listing_id:           string
  quantity_per_unit?:   number
  variation_id?:        string | null
  variation_attributes?: Record<string, unknown> | null
  account_id?:          string | null
  listing_title?:       string | null
  listing_price?:       number | null
  listing_thumbnail?:   string | null
  listing_permalink?:   string | null
}

export interface CreateStockMovementDto {
  product_id:       string
  product_stock_id?: string
  type:             'in' | 'out' | 'adjustment' | 'sale' | 'return' | 'transfer'
  quantity:         number
  reason?:          string | null
}

export interface UpdateStockDto {
  quantity?:            number
  virtual_quantity?:    number
  min_stock_to_pause?:  number
  auto_pause_enabled?:  boolean
}

@Injectable()
export class ProductsService {
  constructor(private readonly stock: StockService) {}

  async getAll(orgId: string | null) {
    const query = supabaseAdmin.from('products').select(PRODUCT_FIELDS)
    // When no org membership, return all products (user is likely sole owner)
    const { data, error } = await (
      orgId
        ? query.eq('organization_id', orgId)
        : query
    ).order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  }

  /** Server-side pagination + filtering pra DataTable view do /produtos.
   * quick_filter: 'all'|'active'|'paused'|'no_stock'|'critical'|'in_ads'|'no_ads' */
  async listPaginated(orgId: string | null, opts: {
    page?:        number
    per_page?:    number
    search?:      string
    quick_filter?: string
    sort_by?:     string
    sort_dir?:    'asc' | 'desc'
  }): Promise<{ data: unknown[]; total: number; page: number; per_page: number }> {
    const page    = Math.max(opts.page ?? 1, 1)
    const perPage = Math.min(Math.max(opts.per_page ?? 25, 1), 200)
    const offset  = (page - 1) * perPage
    const sortBy  = opts.sort_by ?? 'created_at'
    const ascending = opts.sort_dir === 'asc'

    // Set de listings em campanha ativa pra os filtros in_ads / no_ads
    let adsListingIds: Set<string> | null = null
    if (opts.quick_filter === 'in_ads' || opts.quick_filter === 'no_ads') {
      adsListingIds = await this.getActiveAdsListingIds(orgId)
    }

    let q = supabaseAdmin
      .from('products')
      .select(PRODUCT_FIELDS, { count: 'exact' })
      .order(sortBy, { ascending })
      .range(offset, offset + perPage - 1)
    if (orgId) q = q.eq('organization_id', orgId)

    if (opts.search?.trim()) {
      const s = opts.search.trim().replace(/%/g, '')
      q = q.or(`name.ilike.%${s}%,sku.ilike.%${s}%,brand.ilike.%${s}%`)
    }
    switch (opts.quick_filter) {
      case 'active':   q = q.eq('status', 'active'); break
      case 'paused':   q = q.eq('status', 'paused'); break
      case 'no_stock': q = q.or('stock.eq.0,stock.is.null'); break
      case 'critical': q = q.gt('stock', 0).lte('stock', 5); break
      case 'in_ads':
        if (adsListingIds && adsListingIds.size > 0) q = q.in('ml_listing_id', [...adsListingIds])
        else                                          q = q.eq('id', '00000000-0000-0000-0000-000000000000') // forces empty
        break
      case 'no_ads':
        if (adsListingIds && adsListingIds.size > 0) q = q.or(`ml_listing_id.is.null,ml_listing_id.not.in.(${[...adsListingIds].join(',')})`)
        // se sem campanhas ativas, todos sem ads → sem filtro adicional
        break
    }

    const { data, count, error } = await q
    if (error) throw new Error(error.message)
    return { data: data ?? [], total: count ?? 0, page, per_page: perPage }
  }

  /** KPIs do catálogo — alimenta o painel "Catálogo" em /produtos. */
  async getKpis(orgId: string | null): Promise<{ active: number; no_stock: number; critical: number; no_ads: number }> {
    const buildBase = () => {
      const q = supabaseAdmin.from('products').select('id', { count: 'exact', head: true })
      return orgId ? q.eq('organization_id', orgId) : q
    }

    const [activeRes, noStockRes, criticalRes, allListingsRes, adsIds] = await Promise.all([
      buildBase().eq('status', 'active'),
      buildBase().or('stock.eq.0,stock.is.null'),
      buildBase().gt('stock', 0).lte('stock', 5),
      (orgId
        ? supabaseAdmin.from('products').select('ml_listing_id').eq('organization_id', orgId).not('ml_listing_id', 'is', null)
        : supabaseAdmin.from('products').select('ml_listing_id').not('ml_listing_id', 'is', null)
      ),
      this.getActiveAdsListingIds(orgId),
    ])

    const allListings = ((allListingsRes.data ?? []) as Array<{ ml_listing_id: string | null }>)
      .map(r => r.ml_listing_id)
      .filter((id): id is string => !!id)
    const noAds = allListings.filter(id => !adsIds.has(id)).length

    return {
      active:   activeRes.count   ?? 0,
      no_stock: noStockRes.count  ?? 0,
      critical: criticalRes.count ?? 0,
      no_ads:   noAds,
    }
  }

  /** Set de ml_listing_id que estão em ml_ads_campaigns ativas da org. */
  private async getActiveAdsListingIds(orgId: string | null): Promise<Set<string>> {
    let q = supabaseAdmin
      .from('ml_ads_campaigns')
      .select('items')
      .eq('status', 'active')
    if (orgId) q = q.eq('organization_id', orgId)
    const { data } = await q
    const out = new Set<string>()
    for (const c of (data ?? []) as Array<{ items?: string[] | null }>) {
      for (const id of (c.items ?? [])) if (typeof id === 'string') out.add(id)
    }
    return out
  }

  async getLinkedListingIds(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('products')
      .select('ml_listing_id')
      .not('ml_listing_id', 'is', null)
    return (data ?? []).map((r: any) => r.ml_listing_id as string)
  }

  async getById(id: string) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('id', id)
      .single()
    if (error || !data) throw new NotFoundException('Produto não encontrado')
    return data
  }

  async updateFull(id: string, payload: Record<string, unknown>) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id')
      .single()
    if (error || !data) throw new NotFoundException('Produto não encontrado')
    return data
  }

  async updateCosts(orgId: string | null, productId: string, dto: UpdateProductCostsDto) {
    let query = supabaseAdmin
      .from('products')
      .update({
        cost_price:     dto.cost_price     ?? null,
        tax_percentage: dto.tax_percentage ?? null,
        tax_on_freight: dto.tax_on_freight ?? false,
        updated_at:     new Date().toISOString(),
      })
      .eq('id', productId)

    // Só filtra por org quando orgId está presente — produtos criados sem org têm organization_id null
    if (orgId) query = (query as any).eq('organization_id', orgId)

    const { data, error } = await (query as any)
      .select('id, cost_price, tax_percentage, tax_on_freight')
      .single()

    if (error || !data) throw new NotFoundException('Produto não encontrado')
    return data
  }

  async deleteProduct(id: string) {
    const { error } = await supabaseAdmin
      .from('products')
      .delete()
      .eq('id', id)
    if (error) throw new Error(error.message)
  }

  async deleteMany(ids: string[]) {
    const { error } = await supabaseAdmin
      .from('products')
      .delete()
      .in('id', ids)
    if (error) throw new Error(error.message)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createVinculo(dto: any) {
    const { data, error } = await supabaseAdmin
      .from('product_listings')
      .insert({
        product_id:           dto.product_id,
        platform:             dto.platform          ?? 'mercadolivre',
        listing_id:           dto.listing_id,
        quantity_per_unit:    dto.quantity_per_unit ?? 1,
        variation_id:         dto.variation_id      ?? null,
        variation_attributes: dto.variation_attributes ?? null,
        account_id:           dto.account_id        ?? null,
        listing_title:        dto.listing_title     ?? null,
        listing_price:        dto.listing_price     ?? null,
        listing_thumbnail:    dto.listing_thumbnail ?? null,
        listing_permalink:    dto.listing_permalink ?? null,
        is_active:            true,
      })
      .select()
      .single()
    if (error) {
      console.error('[vinculos.service] erro Supabase:', JSON.stringify(error))
      throw new Error(error.message)
    }
    return data
  }

  async deleteVinculo(id: string) {
    const { error } = await supabaseAdmin
      .from('product_listings')
      .delete()
      .eq('id', id)
    if (error) throw new Error(error.message)
  }

  async createStockMovement(dto: CreateStockMovementDto, userId?: string | null) {
    try {
      // Resolve stock record (use shared stock if no explicit stockId)
      let stockId    = dto.product_stock_id ?? null
      let currentQty = 0
      if (!stockId) {
        const { data: stock } = await supabaseAdmin
          .from('product_stock')
          .select('id, quantity')
          .eq('product_id', dto.product_id)
          .is('platform', null)
          .maybeSingle()
        stockId    = stock?.id       ?? null
        currentQty = stock?.quantity ?? 0
      } else {
        const { data: stock } = await supabaseAdmin
          .from('product_stock')
          .select('quantity')
          .eq('id', stockId)
          .maybeSingle()
        currentQty = stock?.quantity ?? 0
      }

      // Compute final balance based on movement type
      const balanceAfter = dto.type === 'adjustment'
        ? dto.quantity
        : dto.type === 'in' || dto.type === 'return'
          ? currentQty + dto.quantity
          : Math.max(0, currentQty - dto.quantity)

      // Insert movement record — column names match the live schema:
      //   stock_id (not product_stock_id), movement_type (not type),
      //   notes (not reason), balance_after (NOT NULL), created_by
      const { error: mvError } = await supabaseAdmin
        .from('stock_movements')
        .insert({
          product_id:    dto.product_id,
          stock_id:      stockId,
          movement_type: dto.type,
          quantity:      dto.quantity,
          notes:         dto.reason ?? null,
          balance_after: balanceAfter,
          created_by:    userId ?? null,
        })
      if (mvError) {
        console.error('[stock.movement] INSERT err:', mvError.code, mvError.message, mvError.details)
        throw new HttpException(mvError.message, 400)
      }

      // Update stock quantity + sync to ML
      if (stockId) {
        await supabaseAdmin
          .from('product_stock')
          .update({ quantity: balanceAfter, updated_at: new Date().toISOString() })
          .eq('id', stockId)

        // Use new path so stock_sync_logs gets populated
        this.stock.syncStockToAllChannels(dto.product_id, 'movement')
          .catch((e: Error) => console.error('[stock-sync] movement sync falhou:', e.message))
      }

      return { ok: true, type: dto.type, quantity: dto.quantity, balance_after: balanceAfter }
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e
      const err = e as Error
      console.error('[stock.movement] ERRO:', err?.message, err?.stack)
      throw new HttpException(err?.message ?? 'Erro ao criar movimento de estoque', 400)
    }
  }

  async updateStock(stockId: string, dto: UpdateStockDto) {
    // Fetch current values to calculate platform_qty
    const { data: current } = await supabaseAdmin
      .from('product_stock')
      .select('product_id, quantity, virtual_quantity')
      .eq('id', stockId)
      .maybeSingle()

    const { data, error } = await supabaseAdmin
      .from('product_stock')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', stockId)
      .select()
      .single()
    if (error) throw new Error(error.message)

    if (current && (dto.quantity !== undefined || dto.virtual_quantity !== undefined)) {
      this.stock.syncStockToAllChannels(current.product_id, 'manual_update')
        .catch((e: Error) => console.error('[stock-sync] updateStock sync falhou:', e.message))
    }

    return data
  }

  async getBySku(orgId: string, sku: string) {
    const { data } = await supabaseAdmin
      .from('products')
      .select('id, name, sku, cost_price, tax_percentage, tax_on_freight')
      .eq('organization_id', orgId)
      .eq('sku', sku)
      .maybeSingle()
    return data ?? null
  }
}
