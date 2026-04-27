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

/** Raw shape returned by both /orders/billing-info/{site}/{id} and the
 * legacy /orders/{id}/billing_info endpoints — the structured object that
 * lives at `data.buyer.billing_info`. */
export interface MlBillingInfoRaw {
  id?:           string
  identification?: { type?: string; number?: string }
  name?:         string
  last_name?:    string
  doc_type?:     string                 // legacy parity
  doc_number?:   string                 // legacy parity
  address?: {
    country_id?:    string
    state?:         { id?: string; name?: string }
    city?:          { id?: string; name?: string }
    zip_code?:      string
    street_name?:   string
    street_number?: string
    comment?:       string
    neighborhood?:  { id?: string; name?: string }
  }
  taxes?: unknown
}

/** Resultado do orchestrator de 2 passos. */
export interface MlBillingFetchResult {
  billing:        MlBillingInfoRaw | null
  billingInfoId:  string | null
  log:            string[]
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

  /** PASSO 1 do fluxo oficial — `GET /orders/{id}` retorna o pedido inteiro,
   * incluindo `buyer.billing_info.id` que precisamos pra resolver dados
   * fiscais no PASSO 2. Sempre envia `x-version: 2`. Lança em erro pra que o
   * orchestrator capture status (404 = pedido fora de janela). */
  async fetchOrder(token: string, externalOrderId: number | string): Promise<unknown> {
    const { data } = await axios.get(`${ML_BASE}/orders/${externalOrderId}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-version': '2' },
      timeout: 8_000,
    })
    return data
  }

  /** PASSO 2 (NOVO endpoint recomendado pela ML).
   * `GET /orders/billing-info/{site_id}/{billing_info_id}` retorna o objeto
   * completo de billing fiscal (identification + nome + endereço). */
  async fetchBillingInfoById(
    token: string,
    siteId: string,
    billingInfoId: string,
  ): Promise<MlBillingInfoRaw | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await axios.get<any>(
      `${ML_BASE}/orders/billing-info/${siteId}/${billingInfoId}`,
      {
        headers: { Authorization: `Bearer ${token}`, 'x-version': '2' },
        timeout: 8_000,
      },
    )
    return (data?.buyer?.billing_info ?? data?.billing_info ?? null) as MlBillingInfoRaw | null
  }

  /** PASSO 2 (LEGADO — fallback).
   * `GET /orders/{id}/billing_info` ainda funciona em alguns casos mas será
   * descontinuado. Usado apenas se PASSO 2 NOVO falhou ou se não temos o
   * billing_info_id. */
  async fetchBillingInfoLegacy(token: string, externalOrderId: number | string): Promise<MlBillingInfoRaw | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await axios.get<any>(`${ML_BASE}/orders/${externalOrderId}/billing_info`, {
      headers: { Authorization: `Bearer ${token}`, 'x-version': '2' },
      timeout: 8_000,
    })
    return (data?.buyer?.billing_info ?? null) as MlBillingInfoRaw | null
  }

  /** Orchestrator do fluxo de 2 passos. Nunca lança. Retorna sempre um log
   * estruturado pra observabilidade — cada chamada produz uma linha
   *   `[ml-sync.billing] order=X cpf=Y log=order_fetched|billing_v2_ok|...`
   * no consumer.
   *
   * Cascade:
   *   1. fetchOrder → extrai buyer.billing_info.id
   *   2a. Se temos id → fetchBillingInfoById (NOVO)
   *   2b. Se 2a falhou OU sem id → fetchBillingInfoLegacy (LEGADO)
   *
   * Quando ambos falharem retorna { billing: null, billingInfoId: null }
   * — o caller deve stampar buyer_billing_fetched_at = now() pra não tentar
   * de novo o mesmo pedido falho. */
  async fetchCompleteBillingForOrder(
    token: string,
    externalOrderId: number | string,
  ): Promise<MlBillingFetchResult> {
    const log: string[] = []
    let billingInfoId: string | null = null

    // PASSO 1
    let orderData: { buyer?: { billing_info?: { id?: string } } } | null = null
    try {
      orderData = (await this.fetchOrder(token, externalOrderId)) as typeof orderData
      log.push('order_fetched')
      billingInfoId = orderData?.buyer?.billing_info?.id ?? null
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0
      log.push(`order_failed:${status}`)
      // mesmo sem o ID podemos tentar o legado
    }

    // PASSO 2A — endpoint NOVO
    if (billingInfoId) {
      try {
        const billing = await this.fetchBillingInfoById(token, 'MLB', billingInfoId)
        if (billing) {
          log.push(`billing_v2_ok:${billingInfoId}`)
          return { billing, billingInfoId, log }
        }
        log.push('billing_v2_empty')
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status ?? 0
        log.push(`billing_v2_failed:${status}`)
      }
    } else {
      log.push('no_billing_info_id')
    }

    // PASSO 2B — endpoint LEGADO
    try {
      const billing = await this.fetchBillingInfoLegacy(token, externalOrderId)
      if (billing) {
        log.push('billing_legacy_ok')
        return { billing, billingInfoId, log }
      }
      log.push('billing_legacy_empty')
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0
      log.push(`billing_legacy_failed:${status}`)
    }

    return { billing: null, billingInfoId, log }
  }

  /** Pull buyer profile via /users/{id}. Usado APENAS quando billing veio
   * vazio — para preencher phone/first_name/last_name. NÃO usar pra email
   * (LGPD; email só vem do enrichment cascade). Nunca lança. */
  async fetchBuyerUser(token: string, buyerId: number): Promise<{
    first_name: string | null
    last_name:  string | null
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
        phone:      pickPhone(phoneObj) ?? pickPhone(altObj),
      }
    } catch {
      return null
    }
  }
}
