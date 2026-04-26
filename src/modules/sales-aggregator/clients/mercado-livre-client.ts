import { Injectable } from '@nestjs/common'
import axios from 'axios'
import { MercadolivreService } from '../../mercadolivre/mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'
const RATE_LIMIT_MS = 200 // max 5 req/s

export interface MlOrderItem {
  item: {
    id: string
    title: string
    seller_sku: string | null
    variation_id: string | null
  }
  quantity: number
  unit_price: number
  full_unit_price: number
  sale_fee: number
}

export interface MlOrder {
  id: number
  date_created: string
  date_closed: string | null
  last_updated: string
  order_items: MlOrderItem[]
  total_amount: number
  paid_amount: number
  status: string
  status_detail: string | null
  buyer: {
    id: number
    nickname: string
    first_name?: string
    last_name?: string
  }
  shipping: { id: number } | null
  payments: Array<{ payment_method_id: string; payment_type: string }>
}

@Injectable()
export class MercadoLivreClient {
  private lastRequestAt = 0

  constructor(private readonly ml: MercadolivreService) {}

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed))
    }
    this.lastRequestAt = Date.now()
  }

  private async withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      await this.rateLimit()
      return await fn()
    } catch (err: unknown) {
      const e = err as { response?: { status?: number } }
      const status = e?.response?.status ?? 0
      if ((status === 429 || status >= 500) && attempt < 4) {
        const delay = Math.pow(2, attempt) * 1000
        await new Promise(r => setTimeout(r, delay))
        return this.withRetry(fn, attempt + 1)
      }
      throw err
    }
  }

  async getTokenForOrg(orgId: string): Promise<{ token: string; sellerId: number }> {
    return this.ml.getTokenForOrg(orgId)
  }

  async fetchOrdersByDateRange(
    token: string,
    sellerId: number,
    dateFrom: string, // YYYY-MM-DD
    dateTo: string,   // YYYY-MM-DD
  ): Promise<{ orders: MlOrder[]; apiCalls: number }> {
    const allOrders: MlOrder[] = []
    let offset = 0
    let total: number | null = null
    let apiCalls = 0

    do {
      const url =
        `${ML_BASE}/orders/search?seller=${sellerId}&limit=50&offset=${offset}` +
        `&order.date_created.from=${dateFrom}T00:00:00.000-03:00` +
        `&order.date_created.to=${dateTo}T23:59:59.999-03:00`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await this.withRetry<any>(() =>
        axios.get(url, { headers: { Authorization: `Bearer ${token}` } }),
      )
      apiCalls++

      const results: MlOrder[] = data?.results ?? []
      if (total === null) total = data?.paging?.total ?? 0
      allOrders.push(...results)
      offset += 50
    } while (
      allOrders.length < (total ?? 0) &&
      allOrders.length < 1000 // safety cap
    )

    return { orders: allOrders, apiCalls }
  }

  async fetchShipmentCost(token: string, shipmentId: number): Promise<number> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await this.withRetry<any>(() =>
        axios.get(`${ML_BASE}/shipments/${shipmentId}/costs`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      )
      return (data?.senders?.[0]?.cost as number) ?? 0
    } catch {
      return 0
    }
  }
}
