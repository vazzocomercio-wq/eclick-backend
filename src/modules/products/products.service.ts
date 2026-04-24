import { Injectable, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

const PRODUCT_FIELDS = `id,name,sku,brand,price,stock,status,platforms,photo_urls,
  ml_title,condition,category,created_at,
  wholesale_enabled,wholesale_levels,ml_listing_type,
  ml_free_shipping,ml_flex,ml_listing_id,ml_permalink,cost_price,tax_percentage,tax_on_freight`

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
    console.log('[products.updateCosts] id:', productId, '| orgId:', orgId, '| dto:', dto)

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

    console.log('[products.updateCosts] resultado:', { data, error: error?.message })
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
    console.log('[vinculos.service] inserindo:', JSON.stringify(dto))
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

  async createStockMovement(dto: CreateStockMovementDto) {
    // Resolve stock record (use shared stock if no explicit stockId)
    let stockId = dto.product_stock_id ?? null
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

    // Insert movement record
    const { error: mvError } = await supabaseAdmin
      .from('stock_movements')
      .insert({
        product_id:       dto.product_id,
        product_stock_id: stockId,
        type:             dto.type,
        quantity:         dto.quantity,
        reason:           dto.reason ?? null,
      })
    if (mvError) throw new Error(mvError.message)

    // Update stock quantity
    if (stockId) {
      const newQty = dto.type === 'adjustment'
        ? dto.quantity
        : dto.type === 'in' || dto.type === 'return'
          ? currentQty + dto.quantity
          : Math.max(0, currentQty - dto.quantity)

      await supabaseAdmin
        .from('product_stock')
        .update({ quantity: newQty, updated_at: new Date().toISOString() })
        .eq('id', stockId)
    }

    return { ok: true, type: dto.type, quantity: dto.quantity }
  }

  async updateStock(stockId: string, dto: UpdateStockDto) {
    const { data, error } = await supabaseAdmin
      .from('product_stock')
      .update({ ...dto, updated_at: new Date().toISOString() })
      .eq('id', stockId)
      .select()
      .single()
    if (error) throw new Error(error.message)
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
