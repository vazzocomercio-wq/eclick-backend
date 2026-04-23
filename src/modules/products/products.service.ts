import { Injectable, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface UpdateProductCostsDto {
  cost_price?:    number | null
  tax_percentage?: number | null
  tax_on_freight?: boolean
}

@Injectable()
export class ProductsService {
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
