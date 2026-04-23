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

@Injectable()
export class ProductsService {
  async getAll(orgId: string | null) {
    const query = supabaseAdmin.from('products').select(PRODUCT_FIELDS)
    const { data, error } = await (
      orgId
        ? query.eq('organization_id', orgId)
        : query.is('organization_id', null)
    ).order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return data ?? []
  }

  async updateCosts(orgId: string, productId: string, dto: UpdateProductCostsDto) {
    const { data, error } = await supabaseAdmin
      .from('products')
      .update({
        cost_price:    dto.cost_price    ?? null,
        tax_percentage: dto.tax_percentage ?? null,
        tax_on_freight: dto.tax_on_freight ?? false,
        updated_at:    new Date().toISOString(),
      })
      .eq('id', productId)
      .eq('organization_id', orgId)
      .select('id, cost_price, tax_percentage, tax_on_freight')
      .single()

    if (error || !data) throw new NotFoundException('Produto não encontrado')
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
