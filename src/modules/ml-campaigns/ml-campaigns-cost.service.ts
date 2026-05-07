/** Calculo detalhado de custos pra um item × campanha em um determinado preco.
 *
 *  Componentes:
 *   - cost_price (do produto)
 *   - tax (cost_price × tax_percentage)
 *   - ml_commission (preco × commission_pct do listing_prices)
 *   - ml_fixed_fee (do listing_prices)
 *   - free_shipping_cost (se ml_logistic_type == 'free_shipping' OR seller paga)
 *   - packaging_cost + operational_cost (defaults da config)
 *   - meli_subsidy_brl (se ML subsidia, abate da tarifa)
 *
 *  Cache de listing_prices por (categoria, faixa de preco) com TTL 7d.
 */

import { Injectable, Logger } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MlCampaignsApiClient } from './ml-campaigns-api.client'
import type { CostBreakdown, CampaignsConfig } from './ml-campaigns.types'

interface ProductRow {
  cost_price:           number | null
  tax_percentage:       number | null
  weight_kg:            number | null
  category_id:          string | null
  // ML metadata
}

interface ListingPriceCacheRow {
  sale_fee_amount:      number | null
  sale_fee_percentage:  number | null
  fixed_fee:            number | null
  free_shipping_cost:   number | null
  expires_at:           string
}

@Injectable()
export class MlCampaignsCostService {
  private readonly logger = new Logger(MlCampaignsCostService.name)

  constructor(private readonly client: MlCampaignsApiClient) {}

  /** Calcula custos completos pra (produto, preco, subsidio, frete-gratis). */
  async calculate(opts: {
    orgId:                 string
    sellerId:              number
    productId:             string | null
    price:                 number
    meli_subsidy_brl?:     number
    free_shipping?:        boolean       // se seller paga frete gratis
    config:                CampaignsConfig
    token:                 string        // pra fetch listing_prices se cache miss
  }): Promise<CostBreakdown> {
    const { orgId, sellerId, productId, price, config, token } = opts

    // 1. Custo + imposto do produto
    let cost_price     = 0
    let tax_percentage = 0
    let categoryMlId   = ''

    if (productId) {
      const { data: p } = await supabaseAdmin
        .from('products')
        .select('cost_price, tax_percentage')
        .eq('id', productId)
        .maybeSingle()
      if (p) {
        cost_price     = (p as ProductRow).cost_price ?? 0
        tax_percentage = (p as ProductRow).tax_percentage ?? 0
      }

      // Tenta inferir categoria ML via listings
      const { data: l } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id')
        .eq('product_id', productId)
        .eq('platform', 'ML')
        .limit(1)
        .maybeSingle()
      // Sem categoria direto na tabela — usaremos um default conservador
      // se necessario. Pra refino futuro, expor category_ml_id em
      // product_listings ou via API ML.
      void l
    }

    const tax_amount = (cost_price * tax_percentage) / 100

    // 2. Comissao ML — usa cache, faz fetch se miss/expired
    const { commission_amount, commission_pct, fixed_fee, free_shipping_cost_for_seller } =
      await this.getCommission({ token, sellerId, categoryMlId, price, freeShipping: !!opts.free_shipping })

    // 3. Custos operacionais (defaults da config)
    const packaging_cost  = config.default_packaging_cost
    const operational_cost = (price * config.default_operational_cost_pct) / 100

    // 4. Subsidio MELI (positivo = abate custo)
    const meli_subsidy_brl = opts.meli_subsidy_brl ?? 0

    // 5. Total
    const total_costs = cost_price
                      + tax_amount
                      + commission_amount
                      + fixed_fee
                      + free_shipping_cost_for_seller
                      + packaging_cost
                      + operational_cost
                      - meli_subsidy_brl

    const net_revenue = price - total_costs

    return {
      cost_price:         round2(cost_price),
      tax_amount:         round2(tax_amount),
      tax_percentage,
      ml_commission:      round2(commission_amount),
      ml_commission_pct:  commission_pct,
      ml_fixed_fee:       round2(fixed_fee),
      free_shipping_cost: round2(free_shipping_cost_for_seller),
      packaging_cost:     round2(packaging_cost),
      operational_cost:   round2(operational_cost),
      meli_subsidy_brl:   round2(meli_subsidy_brl),
      total_costs:        round2(total_costs),
      net_revenue:        round2(net_revenue),
    }
  }

  /** Cache de listing_prices com TTL 7d. Faz fetch ao ML se miss. */
  private async getCommission(opts: {
    token:           string
    sellerId:        number
    categoryMlId:    string
    price:           number
    freeShipping:    boolean
  }): Promise<{
    commission_amount:                number
    commission_pct:                   number
    fixed_fee:                        number
    free_shipping_cost_for_seller:    number
  }> {
    const { token, categoryMlId, price, freeShipping } = opts

    // Sem categoria, usa commission default conservador (16%) — eh o
    // padrao gold_special MLB pra muitas categorias
    if (!categoryMlId) {
      const pct = 16
      return {
        commission_amount:              (price * pct) / 100,
        commission_pct:                 pct,
        fixed_fee:                      0,
        free_shipping_cost_for_seller:  0,
      }
    }

    // Cache lookup: usa categoria + faixa de preco arredondada (multiplo de 50)
    const priceRange = Math.floor(price / 50) * 50
    const { data: cached } = await supabaseAdmin
      .from('ml_listing_prices_cache')
      .select('sale_fee_amount, sale_fee_percentage, fixed_fee, free_shipping_cost, expires_at')
      .eq('ml_category_id', categoryMlId)
      .eq('listing_type_id', 'gold_special')
      .gte('price_range_min', priceRange - 50)
      .lte('price_range_max', priceRange + 50)
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle()

    let row: ListingPriceCacheRow | null = (cached as ListingPriceCacheRow | null) ?? null

    if (!row) {
      // Fetch da API
      try {
        const lp = await this.client.getListingPrices(token, {
          categoryId:    categoryMlId,
          listingTypeId: 'gold_special',
          price,
        })
        const pct        = lp.sale_fee_details?.percentage_fee ?? 0
        const fixedFee   = lp.sale_fee_details?.fixed_fee ?? 0
        const freeShipCost = lp.free_shipping_cost ?? 0

        // Insert cache
        await supabaseAdmin
          .from('ml_listing_prices_cache')
          .insert({
            ml_category_id:      categoryMlId,
            listing_type_id:     'gold_special',
            price_range_min:     priceRange,
            price_range_max:     priceRange + 50,
            sale_fee_amount:     lp.sale_fee_amount ?? null,
            sale_fee_percentage: pct,
            fixed_fee:           fixedFee,
            free_shipping_cost:  freeShipCost,
            raw_response:        lp as unknown,
          })

        row = {
          sale_fee_amount:     lp.sale_fee_amount ?? null,
          sale_fee_percentage: pct,
          fixed_fee:           fixedFee,
          free_shipping_cost:  freeShipCost,
          expires_at:          new Date(Date.now() + 7 * 86_400_000).toISOString(),
        }
      } catch (e) {
        this.logger.warn(`[cost] getListingPrices falhou ${categoryMlId}: ${(e as Error).message}`)
        // Fallback: 16% default
        const pct = 16
        return {
          commission_amount:              (price * pct) / 100,
          commission_pct:                 pct,
          fixed_fee:                      0,
          free_shipping_cost_for_seller:  0,
        }
      }
    }

    const pct = row.sale_fee_percentage ?? 16
    return {
      commission_amount:              row.sale_fee_amount ?? (price * pct) / 100,
      commission_pct:                 pct,
      fixed_fee:                      row.fixed_fee ?? 0,
      free_shipping_cost_for_seller:  freeShipping ? (row.free_shipping_cost ?? 0) : 0,
    }
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
