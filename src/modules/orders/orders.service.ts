import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export interface CreateManualOrderDto {
  platform: string
  product_title: string
  sku?: string
  quantity: number
  sale_price: number
  cost_price?: number
  buyer_name: string
  buyer_phone?: string
  shipping_address?: string
  payment_method: string
  notes?: string
}

@Injectable()
export class OrdersService {
  async createManualOrder(orgId: string, dto: CreateManualOrderDto) {
    const platformFee = dto.platform === 'ml' ? dto.sale_price * 0.115 : 0
    const shippingCost = 0
    const grossProfit = dto.sale_price - platformFee - shippingCost - (dto.cost_price ?? 0)
    const marginPct = dto.sale_price > 0 ? (grossProfit / dto.sale_price) * 100 : 0

    const { data, error } = await supabaseAdmin
      .from('orders')
      .insert({
        source:                 'manual',
        platform:               dto.platform,
        buyer_name:             dto.buyer_name,
        product_title:          dto.product_title,
        sku:                    dto.sku ?? null,
        quantity:               dto.quantity,
        sale_price:             dto.sale_price,
        cost_price:             dto.cost_price ?? null,
        platform_fee:           Math.round(platformFee * 100) / 100,
        shipping_cost:          shippingCost,
        gross_profit:           Math.round(grossProfit * 100) / 100,
        contribution_margin:    Math.round(grossProfit * 100) / 100,
        contribution_margin_pct: Math.round(marginPct * 100) / 100,
        status:                 'pending',
        notes:                  dto.notes ?? null,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    return { id: data.id }
  }

  async getManualOrders(orgId: string, offset = 0, limit = 20) {
    const { data, error, count } = await supabaseAdmin
      .from('orders')
      .select('*', { count: 'exact' })
      .eq('source', 'manual')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw new Error(error.message)
    return { orders: data ?? [], total: count ?? 0 }
  }
}
