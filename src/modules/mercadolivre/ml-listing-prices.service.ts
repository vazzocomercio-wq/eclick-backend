import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

const ML_BASE = 'https://api.mercadolibre.com'

/**
 * Tarifa de venda do ML por (categoria, tipo de anúncio, faixa de preço).
 *
 * Fonte: API `GET /sites/MLB/listing_prices` — retorna `percentage_fee` +
 * `fixed_fee` (o custo fixo que o ML cobra de itens ≤ R$79) + custo de frete
 * grátis. Resultado fica em cache na tabela `ml_listing_prices_cache`
 * (TTL 7 dias, default da própria tabela).
 *
 * Usado pra ESTIMAR a tarifa de anúncios ainda não vendidos. Pedidos
 * concretizados usam o `sale_fee` real do pedido — não passam por aqui.
 *
 * NOTA: `ml-campaigns-cost.service.ts` tem uma cópia dessa lógica de cache
 * (mesma tabela). Dívida conhecida — idealmente aquele service migra pra cá.
 */
@Injectable()
export class MlListingPricesService {
  private readonly logger = new Logger(MlListingPricesService.name)

  /**
   * Resolve a tarifa de venda pra (categoria, tipo, preço). Retorna `null`
   * quando não dá pra resolver (sem categoria, preço inválido ou ML fora).
   */
  async getFee(token: string, opts: {
    categoryId:    string
    listingTypeId: string
    price:         number
  }): Promise<{
    percentageFee:    number   // 0–100
    fixedFee:         number   // R$
    freeShippingCost: number   // R$
    saleFeeAmount:    number   // R$ — tarifa total que o ML retornou
  } | null> {
    const categoryId    = opts.categoryId?.trim()
    const listingTypeId = opts.listingTypeId?.trim() || 'gold_special'
    const price         = Number(opts.price) || 0
    if (!categoryId || price <= 0) return null

    // Cache: chave por categoria + tipo + faixa de preço (múltiplo de 50).
    const priceRange = Math.floor(price / 50) * 50
    const { data: cached } = await supabaseAdmin
      .from('ml_listing_prices_cache')
      .select('sale_fee_amount, sale_fee_percentage, fixed_fee, free_shipping_cost')
      .eq('ml_category_id', categoryId)
      .eq('listing_type_id', listingTypeId)
      .gte('price_range_min', priceRange - 50)
      .lte('price_range_max', priceRange + 50)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle()

    if (cached) {
      const c = cached as {
        sale_fee_amount: number | null; sale_fee_percentage: number | null
        fixed_fee: number | null; free_shipping_cost: number | null
      }
      return {
        percentageFee:    c.sale_fee_percentage ?? 0,
        fixedFee:         c.fixed_fee ?? 0,
        freeShippingCost: c.free_shipping_cost ?? 0,
        saleFeeAmount:    c.sale_fee_amount ?? 0,
      }
    }

    // Cache miss → busca no ML e grava.
    try {
      const { data: lp } = await axios.get<{
        sale_fee_amount?:  number
        sale_fee_details?: { percentage_fee?: number; fixed_fee?: number }
        free_shipping_cost?: number
      }>(`${ML_BASE}/sites/MLB/listing_prices`, {
        headers: { Authorization: `Bearer ${token}` },
        params:  { category_id: categoryId, listing_type_id: listingTypeId, price },
        timeout: 10_000,
      })

      const percentageFee    = lp?.sale_fee_details?.percentage_fee ?? 0
      const fixedFee         = lp?.sale_fee_details?.fixed_fee ?? 0
      const freeShippingCost = lp?.free_shipping_cost ?? 0
      const saleFeeAmount    = lp?.sale_fee_amount ?? 0

      await supabaseAdmin
        .from('ml_listing_prices_cache')
        .insert({
          ml_category_id:      categoryId,
          listing_type_id:     listingTypeId,
          price_range_min:     priceRange,
          price_range_max:     priceRange + 50,
          sale_fee_amount:     saleFeeAmount,
          sale_fee_percentage: percentageFee,
          fixed_fee:           fixedFee,
          free_shipping_cost:  freeShippingCost,
          raw_response:        lp as unknown,
        })

      return { percentageFee, fixedFee, freeShippingCost, saleFeeAmount }
    } catch (e) {
      this.logger.warn(`[listing-prices] fetch falhou cat=${categoryId}: ${(e as Error).message}`)
      return null
    }
  }
}
