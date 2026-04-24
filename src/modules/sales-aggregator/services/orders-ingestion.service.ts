import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { MercadoLivreClient, MlOrder } from '../clients/mercado-livre-client'

interface ProductInfo {
  product_id: string
  cost_price: number | null
  tax_percentage: number | null
  tax_on_freight: boolean
  sku: string | null
}

interface IngestionStats {
  ordersFound: number
  rowsUpserted: number
  apiCalls: number
  errors: Array<{ date: string; error: string }>
}

@Injectable()
export class OrdersIngestionService {
  constructor(private readonly mlClient: MercadoLivreClient) {}

  async ingestDateRange(
    orgId: string,
    dateFrom: string, // YYYY-MM-DD
    dateTo: string,   // YYYY-MM-DD
    runId: string,
  ): Promise<IngestionStats> {
    console.log(`[aggregator] ingestDateRange orgId=${orgId} from=${dateFrom} to=${dateTo}`)

    const { token, sellerId } = await this.mlClient.getTokenForOrg(orgId)

    // Build listing→product lookup map for this org (once, upfront)
    const listingMap = await this.buildListingMap(orgId)
    console.log(`[aggregator] listingMap loaded: ${listingMap.size} listings`)

    const dates = this.buildDateRange(dateFrom, dateTo)
    const stats: IngestionStats = { ordersFound: 0, rowsUpserted: 0, apiCalls: 0, errors: [] }

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i]
      try {
        // Update current processing date
        await supabaseAdmin
          .from('aggregator_runs')
          .update({ current_date_processing: date, processed_dates: i })
          .eq('id', runId)

        const { orders, apiCalls } = await this.mlClient.fetchOrdersByDateRange(token, sellerId, date, date)
        stats.apiCalls += apiCalls
        stats.ordersFound += orders.length

        if (orders.length === 0) continue

        // Fetch shipping costs in parallel (one per order that has shipping)
        const shipIds = [...new Set(orders.map(o => o.shipping?.id).filter(Boolean))] as number[]
        const costMap = new Map<number, number>()
        if (shipIds.length > 0) {
          const costResults = await Promise.allSettled(
            shipIds.map(id => this.mlClient.fetchShipmentCost(token, id)),
          )
          stats.apiCalls += shipIds.length
          shipIds.forEach((id, idx) => {
            const r = costResults[idx]
            costMap.set(id, r.status === 'fulfilled' ? r.value : 0)
          })
        }

        // Build rows for every order item
        const rows = this.buildOrderRows(orgId, orders, costMap, listingMap, sellerId)

        if (rows.length > 0) {
          // Log first row's keys so we can confirm columns match the table schema
          console.log(`[aggregator] ${date}: ${rows.length} rows to upsert, cols:`, Object.keys(rows[0]).join(', '))
          console.log(`[aggregator] ${date}: first row sample:`, JSON.stringify({
            external_order_id: rows[0].external_order_id,
            sku:               rows[0].sku,
            source:            rows[0].source,
            sale_price:        rows[0].sale_price,
            organization_id:   rows[0].organization_id,
          }))

          const BATCH = 100
          for (let b = 0; b < rows.length; b += BATCH) {
            const batch = rows.slice(b, b + BATCH)
            const { error } = await supabaseAdmin
              .from('orders')
              .upsert(batch, {
                onConflict: 'source,external_order_id,sku',
                ignoreDuplicates: false,
              })
            if (error) {
              console.error(`[aggregator] UPSERT FAILED on ${date} batch ${b}–${b + batch.length}:`, error.message)
              console.error(`[aggregator] first row of failed batch:`, JSON.stringify(batch[0]))
              stats.errors.push({ date, error: `upsert batch ${b}: ${error.message}` })
            } else {
              stats.rowsUpserted += batch.length
            }
          }
        }

        // Update run stats
        await supabaseAdmin
          .from('aggregator_runs')
          .update({
            processed_dates: i + 1,
            orders_fetched: stats.ordersFound,
            orders_inserted: stats.rowsUpserted,
            api_calls_made: stats.apiCalls,
          })
          .eq('id', runId)

        console.log(`[aggregator] ${date}: ${orders.length} orders → ${rows.length} rows`)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[aggregator] error on ${date}:`, msg)
        stats.errors.push({ date, error: msg })
      }
    }

    return stats
  }

  private buildOrderRows(
    orgId: string,
    orders: MlOrder[],
    costMap: Map<number, number>,
    listingMap: Map<string, ProductInfo>,
    sellerId: number,
  ): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = []
    const now = new Date().toISOString()

    for (const order of orders) {
      const orderShippingCost = order.shipping?.id ? (costMap.get(order.shipping.id) ?? 0) : 0
      const orderTotal = order.total_amount ?? 1

      for (const item of order.order_items ?? []) {
        const listingId = item.item?.id ?? ''
        const sku = item.item?.seller_sku ?? listingId
        const qty = item.quantity ?? 1
        const unitPrice = item.unit_price ?? 0
        const itemTotal = qty * unitPrice

        // Proportional shipping allocation
        const shippingAlloc = orderTotal > 0 ? orderShippingCost * (itemTotal / orderTotal) : 0

        const prod = listingMap.get(listingId)
        const costPriceTotal = prod?.cost_price != null ? prod.cost_price * qty : null
        const taxOnFreight = prod?.tax_on_freight ?? false
        const taxBase = taxOnFreight ? itemTotal + shippingAlloc : itemTotal
        const taxAmount = prod?.tax_percentage != null ? taxBase * (prod.tax_percentage / 100) : null

        const saleFee = item.sale_fee ?? 0
        const grossProfit = itemTotal - saleFee - shippingAlloc
        const cm = costPriceTotal != null
          ? grossProfit - costPriceTotal - (taxAmount ?? 0)
          : null
        const cmPct = cm != null && itemTotal > 0 ? cm / itemTotal * 100 : null

        const soldAt = order.date_closed ?? order.date_created

        rows.push({
          organization_id:         orgId,
          source:                  'mercadolivre',
          platform:                'mercadolivre',
          external_order_id:       String(order.id),
          marketplace_listing_id:  listingId,
          product_id:              prod?.product_id ?? null,
          product_title:           item.item?.title ?? null,
          sku,
          quantity:                qty,
          sale_price:              unitPrice,
          platform_fee:            Math.round(saleFee * 100) / 100,
          shipping_cost:           Math.round(shippingAlloc * 100) / 100,
          cost_price:              costPriceTotal != null ? Math.round(costPriceTotal * 100) / 100 : null,
          tax_amount:              taxAmount != null ? Math.round(taxAmount * 100) / 100 : null,
          gross_profit:            Math.round(grossProfit * 100) / 100,
          contribution_margin:     cm != null ? Math.round(cm * 100) / 100 : null,
          contribution_margin_pct: cmPct != null ? Math.round(cmPct * 100) / 100 : null,
          status:                  order.status,
          buyer_name:              order.buyer?.nickname ?? null,
          buyer_username:          order.buyer?.nickname ?? null,
          sold_at:                 soldAt,
          raw_data: {
            order_id:     order.id,
            date_created: order.date_created,
            date_closed:  order.date_closed,
            status:       order.status,
            total_amount: order.total_amount,
            item: {
              id:         item.item?.id,
              title:      item.item?.title,
              seller_sku: item.item?.seller_sku,
              quantity:   item.quantity,
              unit_price: item.unit_price,
              sale_fee:   item.sale_fee,
            },
            buyer: {
              id:       order.buyer?.id,
              nickname: order.buyer?.nickname,
            },
            shipping_id: order.shipping?.id ?? null,
          },
          updated_at: now,
        })
      }
    }

    return rows
  }

  private async buildListingMap(orgId: string): Promise<Map<string, ProductInfo>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, product_id, products(cost_price, tax_percentage, tax_on_freight, sku)')
      .eq('platform', 'mercadolivre')
      .eq('is_active', true) as { data: Array<{
        listing_id: string
        product_id: string | null
        products: { cost_price: number | null; tax_percentage: number | null; tax_on_freight: boolean; sku: string | null } | null
      }> | null }

    const map = new Map<string, ProductInfo>()
    for (const row of data ?? []) {
      if (!row.product_id) continue
      const prod = Array.isArray(row.products)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? (row.products as any[])[0]
        : row.products
      map.set(row.listing_id, {
        product_id:     row.product_id,
        cost_price:     prod?.cost_price ?? null,
        tax_percentage: prod?.tax_percentage ?? null,
        tax_on_freight: prod?.tax_on_freight ?? false,
        sku:            prod?.sku ?? null,
      })
    }
    return map
  }

  private buildDateRange(from: string, to: string): string[] {
    const dates: string[] = []
    const cur = new Date(from + 'T12:00:00Z')
    const end = new Date(to + 'T12:00:00Z')
    while (cur <= end) {
      dates.push(cur.toISOString().slice(0, 10))
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
    return dates
  }
}
