import { Injectable } from '@nestjs/common'
import axios from 'axios'
import {
  MarketplaceAdapter, MarketplacePlatform, MpConnection,
  RawOrder, BuyerBilling, AddressShape, TokenPair,
} from './base'
import { MlBillingFetcherService } from '../../mercadolivre/ml-billing-fetcher.service'

const ML_BASE = 'https://api.mercadolibre.com'

/** Mercado Livre adapter — delega ao código existente do MlBillingFetcherService
 * (fluxo 2-passos billing_info já em produção). Não duplica lógica; só plumba
 * pra interface comum. ml_connections continua sendo a tabela primária pra
 * ML — esse adapter é instanciado pelas leituras de marketplace_connections
 * que vão chegar nas Sprints C2.2/C2.3 (Magalu/Shopee), e fica aqui pronto
 * pra consumo futuro. */
@Injectable()
export class MercadoLivreAdapter extends MarketplaceAdapter {
  readonly platform: MarketplacePlatform = 'mercadolivre'

  constructor(private readonly billingFetcher: MlBillingFetcherService) {
    super()
  }

  async listOrders(
    conn:  MpConnection,
    range: { from: Date; to: Date },
  ): Promise<RawOrder[]> {
    if (!conn.access_token) throw new Error('ML connection sem access_token')
    const sellerId = conn.seller_id
    if (!sellerId)         throw new Error('ML connection sem seller_id')

    const out: RawOrder[] = []
    const fromIso = range.from.toISOString().slice(0, 10)
    const toIso   = range.to.toISOString().slice(0, 10)
    let offset = 0
    const limit = 50

    do {
      const url = `${ML_BASE}/orders/search?seller=${sellerId}&limit=${limit}&offset=${offset}` +
        `&order.date_created.from=${fromIso}T00:00:00.000-03:00` +
        `&order.date_created.to=${toIso}T23:59:59.999-03:00`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await axios.get<any>(url, {
        headers: { Authorization: `Bearer ${conn.access_token}` },
      })
      const results: unknown[] = data?.results ?? []
      for (const r of results) {
        const o = r as { id?: number | string; date_created?: string; status?: string }
        if (o.id == null) continue
        out.push({
          external_order_id: String(o.id),
          raw:               r,
          created_at:        o.date_created,
          status:            o.status,
        })
      }
      const total = (data?.paging?.total as number | undefined) ?? out.length
      offset += limit
      if (offset >= total || results.length < limit) break
      if (out.length >= 5000) break // safety cap
    } while (true)

    return out
  }

  async getOrderDetail(
    conn:           MpConnection,
    externalOrderId: string,
  ): Promise<RawOrder> {
    if (!conn.access_token) throw new Error('ML connection sem access_token')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await axios.get<any>(`${ML_BASE}/orders/${externalOrderId}`, {
      headers: { Authorization: `Bearer ${conn.access_token}`, 'x-version': '2' },
    })
    return {
      external_order_id: String(externalOrderId),
      raw:               data,
      created_at:        data?.date_created,
      status:            data?.status,
    }
  }

  /** ML precisa call extra (/orders/billing-info/MLB/{id}) — delega ao
   * fluxo 2-passos do MlBillingFetcherService já em produção. */
  async extractBuyerBilling(
    raw:   RawOrder,
    _conn: MpConnection,
  ): Promise<BuyerBilling | null> {
    const result = await this.billingFetcher.fetchCompleteBillingForOrder(
      raw.external_order_id,
      _conn.access_token ?? '',
    )
    const b = result.billing
    if (!b) return null

    const docNumber = b.identification?.number ?? b.doc_number ?? null
    const docType   = b.identification?.type   ?? b.doc_type   ?? null
    const composedName = [b.name, b.last_name].filter(Boolean).join(' ').trim() || null

    const address: AddressShape | null = b.address ? {
      country_id:    b.address.country_id    ?? null,
      zip_code:      b.address.zip_code      ?? null,
      state:         b.address.state?.name   ?? null,
      city_name:     b.address.city?.name    ?? null,                 // shape antigo aninhado
      neighborhood:  b.address.neighborhood?.name ?? null,
      street_name:   b.address.street_name   ?? null,
      street_number: b.address.street_number ?? null,
      complement:    b.address.comment       ?? null,
    } : null

    return {
      doc_type:        docType === 'CNPJ' ? 'CNPJ' : docType === 'CPF' ? 'CPF' : null,
      doc_number:      docNumber ? docNumber.replace(/\D/g, '') || null : null,
      email:           null, // ML não fornece (LGPD)
      phone:           null, // vem do /users/{buyer_id} no fluxo do fetcher
      name:            composedName,
      last_name:       b.last_name ?? null,
      billing_info_id: result.billingInfoId,
      billing_address: address,
      billing_country: b.address?.country_id ?? 'BR',
    }
  }

  async refreshToken(conn: MpConnection): Promise<TokenPair> {
    if (!conn.refresh_token) throw new Error('ML connection sem refresh_token')
    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: conn.refresh_token,
      client_id:     process.env.ML_CLIENT_ID!,
      client_secret: process.env.ML_CLIENT_SECRET!,
    })
    const { data } = await axios.post<{ access_token: string; refresh_token: string; expires_in: number }>(
      `${ML_BASE}/oauth/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    )
    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    }
  }
}
