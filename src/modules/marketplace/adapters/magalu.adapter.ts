import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import {
  MarketplaceAdapter, MarketplacePlatform, MpConnection,
  RawOrder, BuyerBilling, AddressShape, TokenPair,
} from './base'

const MAGALU_API  = 'https://api.magalu.com'
const MAGALU_AUTH = 'https://id.magalu.com'

/** Magalu Marketplace adapter — 1-step (CPF inline em /orders/{id}, sem
 * fluxo billing-info como ML). X-Channel-Id é HEADER OBRIGATÓRIO; lemos de
 * conn.marketplace_id (preenchido no OAuth callback). Address shape do
 * deliveries[0].address foi mapeado best-effort (docs JS-rendered não
 * permitiram extração verbatim) — campos desconhecidos logam warn pra
 * ajuste após primeira fixture real. */
@Injectable()
export class MagaluAdapter extends MarketplaceAdapter {
  readonly platform: MarketplacePlatform = 'magalu'
  private readonly logger = new Logger(MagaluAdapter.name)

  private headers(conn: MpConnection): Record<string, string> {
    if (!conn.access_token)   throw new Error('Magalu connection sem access_token')
    if (!conn.marketplace_id) throw new Error('Magalu connection sem marketplace_id (X-Channel-Id)')
    return {
      Authorization:   `Bearer ${conn.access_token}`,
      'X-Channel-Id':  conn.marketplace_id,
      Accept:          'application/json',
      'Content-Type':  'application/json',
    }
  }

  async listOrders(
    conn:  MpConnection,
    range: { from: Date; to: Date },
  ): Promise<RawOrder[]> {
    const headers = this.headers(conn)
    const out: RawOrder[] = []
    const limit  = 50
    let   offset = 0
    const fromIso = range.from.toISOString()
    const toIso   = range.to.toISOString()

    do {
      const url = `${MAGALU_API}/seller/v1/orders` +
        `?limit=${limit}&offset=${offset}` +
        `&date_from=${encodeURIComponent(fromIso)}&date_to=${encodeURIComponent(toIso)}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await axios.get<any>(url, { headers })
      const results: unknown[] = data?.results ?? []
      for (const r of results) {
        const o = r as { id?: string; code?: string; created_at?: string; status?: string }
        const externalId = o.code ?? o.id
        if (!externalId) continue
        out.push({
          external_order_id: String(externalId),
          raw:               r,
          created_at:        o.created_at,
          status:            o.status,
        })
      }
      const total = (data?.meta?.page?.count as number | undefined) ?? out.length
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
    const headers = this.headers(conn)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await axios.get<any>(
      `${MAGALU_API}/seller/v1/orders/${encodeURIComponent(externalOrderId)}`,
      { headers },
    )
    return {
      external_order_id: String(externalOrderId),
      raw:               data,
      created_at:        data?.created_at,
      status:            data?.status,
    }
  }

  /** CPF inline — sem call extra. customer.document_number + customer_type
   * discrimina CPF/CNPJ. Address vem em deliveries[0].address (shape
   * best-effort: street/number/complement/neighborhood/city/state/zip_code). */
  async extractBuyerBilling(
    raw:   RawOrder,
    _conn: MpConnection,
  ): Promise<BuyerBilling | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = raw.raw as any
    const customer = r?.customer
    if (!customer) return null

    const docTypeRaw = String(customer.customer_type ?? '').toLowerCase()
    const docType: 'CPF' | 'CNPJ' | null =
      docTypeRaw === 'cnpj' ? 'CNPJ' :
      docTypeRaw === 'cpf'  ? 'CPF'  : null
    const docNumber = customer.document_number
      ? String(customer.document_number).replace(/\D/g, '') || null
      : null

    const phone = this.firstPhone(customer.phones)

    const deliveryAddr = r?.deliveries?.[0]?.address ?? null
    const address: AddressShape | null = deliveryAddr
      ? this.mapAddress(deliveryAddr)
      : null

    return {
      doc_type:        docType,
      doc_number:      docNumber,
      email:           customer.email ?? null,
      phone,
      name:            customer.name ?? null,
      last_name:       null, // Magalu não separa first/last
      billing_info_id: null, // não existe equivalente ao ML billing_info_id
      billing_address: address,
      billing_country: address?.country_id ?? 'BR',
    }
  }

  async refreshToken(conn: MpConnection): Promise<TokenPair> {
    if (!conn.refresh_token) throw new Error('Magalu connection sem refresh_token')
    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: conn.refresh_token,
      client_id:     process.env.MAGALU_CLIENT_ID!,
      client_secret: process.env.MAGALU_CLIENT_SECRET!,
    })
    const { data } = await axios.post<{ access_token: string; refresh_token: string; expires_in: number }>(
      `${MAGALU_AUTH}/oauth/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    )
    return {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private firstPhone(phones: any[] | null | undefined): string | null {
    if (!Array.isArray(phones) || phones.length === 0) return null
    const p = phones[0] ?? {}
    const cc = p.country_code ? String(p.country_code) : ''
    const ac = p.area_code    ? String(p.area_code)    : ''
    const nm = p.number       ? String(p.number)       : ''
    const joined = `${cc}${ac}${nm}`.replace(/\D/g, '')
    return joined || null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapAddress(a: any): AddressShape {
    // Best-effort PT-BR convention. Field names não-confirmados verbatim →
    // logamos warn se vierem campos desconhecidos pra ajustar pós-fixture.
    const known = new Set([
      'street', 'number', 'complement', 'neighborhood', 'district',
      'city', 'state', 'zip_code', 'zipcode', 'country', 'country_code',
      'reference',
    ])
    const unknown = Object.keys(a).filter(k => !known.has(k))
    if (unknown.length) {
      this.logger.warn(`[magalu.address] campos não mapeados: ${unknown.join(',')}`)
    }
    return {
      country_id:    a.country_code ?? a.country ?? 'BR',
      zip_code:      a.zip_code ?? a.zipcode ?? null,
      state:         a.state ?? null,
      city_name:     a.city ?? null,
      neighborhood:  a.neighborhood ?? a.district ?? null,
      street_name:   a.street ?? null,
      street_number: a.number ? String(a.number) : null,
      complement:    a.complement ?? null,
    }
  }
}
