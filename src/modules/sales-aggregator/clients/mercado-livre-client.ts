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
    email?: string
  }
  shipping: { id: number } | null
  payments: Array<{ payment_method_id: string; payment_type: string }>
}

export interface MlBuyerBilling {
  doc_type:   string | null
  doc_number: string | null
  email:      string | null
  phone:      string | null
  name:       string | null
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

  /** Pull billing info for one order. Caller is responsible for the 1 req/sec
   * pacing — this method does NOT go through the shared rate-limiter so it
   * doesn't compete with order-search and shipment bursts. Never throws:
   * 401/403/404 (token expired or order out of CPF visibility window) and
   * timeouts all return null.
   *
   * Sends `x-version: 2` per ML's recommendation for the new billing endpoint.
   * Note: ML does NOT release email/phone here for most B2C sales (LGPD).
   * The fix for those is the enrichment cascade (Direct Data with the CPF
   * returned here will resolve full phones/emails). */
  async fetchBillingInfo(token: string, externalOrderId: number): Promise<MlBuyerBilling | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await axios.get<any>(`${ML_BASE}/orders/${externalOrderId}/billing_info`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'x-version':   '2',
        },
        timeout: 8_000,
      })
      const buyer    = (data?.buyer ?? {}) as Record<string, unknown>
      const billing  = (buyer.billing_info ?? {}) as Record<string, unknown>
      const phoneObj = (buyer.phone ?? {}) as Record<string, unknown>
      const phoneStr = phoneObj.area_code && phoneObj.number
        ? `${phoneObj.area_code}${phoneObj.number}`
        : ((phoneObj.number as string) ?? null)
      const billingName = (billing.name as string | undefined) ?? null
      const composedName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || null
      const fullName = billingName ?? composedName
      return {
        doc_type:   (billing.doc_type as string)   ?? null,
        doc_number: ((billing.doc_number as string) ?? '').replace(/\D/g, '') || null,
        email:      (buyer.email as string)        ?? null,
        phone:      phoneStr ? phoneStr.replace(/\D/g, '') : null,
        name:       fullName,
      }
    } catch {
      // 401/403/404/timeout/network — any failure: return null and let the
      // caller stamp buyer_billing_fetched_at anyway so we don't retry forever.
      return null
    }
  }

  /** Pull buyer profile via /users/{id}. Used as a fallback for phone/email
   * since billing_info often returns these blank for LGPD reasons. ML
   * enforces ~50 req/sec on this endpoint — the shared rateLimit() handles
   * pacing well below that. Never throws. */
  async fetchBuyerUser(token: string, buyerId: number): Promise<{
    first_name: string | null
    last_name:  string | null
    email:      string | null
    phone:      string | null
  } | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await this.withRetry<any>(() =>
        axios.get(`${ML_BASE}/users/${buyerId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5_000,
        }),
      )
      const phoneObj = (data?.phone ?? {}) as Record<string, unknown>
      const altObj   = (data?.alternative_phone ?? {}) as Record<string, unknown>
      const pickPhone = (o: Record<string, unknown>) => {
        const ac = (o.area_code as string) ?? ''
        const n  = (o.number    as string) ?? ''
        const joined = `${ac}${n}`.replace(/\D/g, '')
        return joined.length >= 10 ? joined : null
      }
      return {
        first_name: (data?.first_name as string) ?? null,
        last_name:  (data?.last_name  as string) ?? null,
        email:      (data?.email      as string) ?? null,
        phone:      pickPhone(phoneObj) ?? pickPhone(altObj),
      }
    } catch {
      return null
    }
  }
}
