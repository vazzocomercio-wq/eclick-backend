import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from './mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/** Raw shape returned by both /orders/billing-info/{site}/{id} (NEW) and
 * /orders/{id}/billing_info (LEGACY). */
interface BillingInfoRaw {
  id?:           string
  identification?: { type?: string; number?: string }
  name?:         string
  last_name?:    string
  doc_type?:     string
  doc_number?:   string
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
}

interface CompleteBillingResult {
  billing:        BillingInfoRaw | null
  billingInfoId:  string | null
  log:            string[]
}

/** Pulls buyer billing info from ML using the official 2-step flow:
 *   1. GET /orders/{id}                              → buyer.billing_info.id
 *   2. GET /orders/billing-info/MLB/{billing_info_id} → identification + address
 * Falls back to GET /orders/{id}/billing_info (legacy, deprecating) when
 * the new endpoint can't resolve. The DB trigger `trg_sync_buyer`
 * propagates each update into unified_customers automatically. */
@Injectable()
export class MlBillingFetcherService {
  private readonly logger = new Logger(MlBillingFetcherService.name)

  constructor(private readonly ml: MercadolivreService) {}

  // ── ML helpers (each call sends x-version: 2) ──────────────────────────────

  private async fetchOrder(externalOrderId: string, token: string): Promise<unknown> {
    const { data } = await axios.get(`${ML_BASE}/orders/${externalOrderId}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-version': '2' },
      timeout: 8_000,
    })
    return data
  }

  private async fetchBillingInfoById(siteId: string, billingInfoId: string, token: string): Promise<BillingInfoRaw | null> {
    const { data } = await axios.get<{ buyer?: { billing_info?: BillingInfoRaw }; billing_info?: BillingInfoRaw }>(
      `${ML_BASE}/orders/billing-info/${siteId}/${billingInfoId}`,
      { headers: { Authorization: `Bearer ${token}`, 'x-version': '2' }, timeout: 8_000 },
    )
    return data?.buyer?.billing_info ?? data?.billing_info ?? null
  }

  private async fetchBillingInfoLegacy(externalOrderId: string, token: string): Promise<BillingInfoRaw | null> {
    const { data } = await axios.get<{ buyer?: { billing_info?: BillingInfoRaw } }>(
      `${ML_BASE}/orders/${externalOrderId}/billing_info`,
      { headers: { Authorization: `Bearer ${token}`, 'x-version': '2' }, timeout: 8_000 },
    )
    return data?.buyer?.billing_info ?? null
  }

  /** 2-step orchestrator. Never throws — always returns a structured log. */
  async fetchCompleteBillingForOrder(externalOrderId: string, token: string): Promise<CompleteBillingResult> {
    const log: string[] = []
    let billingInfoId: string | null = null

    // PASSO 1
    try {
      const order = await this.fetchOrder(externalOrderId, token) as { buyer?: { billing_info?: { id?: string } } } | null
      log.push('order_fetched')
      billingInfoId = order?.buyer?.billing_info?.id ?? null
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status ?? 0
      log.push(`order_failed:${status}`)
    }

    // PASSO 2A — endpoint NOVO
    if (billingInfoId) {
      try {
        const billing = await this.fetchBillingInfoById('MLB', billingInfoId, token)
        if (billing) {
          log.push(`billing_v2_ok:${billingInfoId}`)
          return { billing, billingInfoId, log }
        }
        log.push('billing_v2_empty')
      } catch (e: unknown) {
        const status = (e as { response?: { status?: number } })?.response?.status ?? 0
        log.push(`billing_v2_failed:${status}`)
      }
    } else {
      log.push('no_billing_info_id')
    }

    // PASSO 2B — endpoint LEGADO
    try {
      const billing = await this.fetchBillingInfoLegacy(externalOrderId, token)
      if (billing) {
        log.push('billing_legacy_ok')
        return { billing, billingInfoId, log }
      }
      log.push('billing_legacy_empty')
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } })?.response?.status ?? 0
      log.push(`billing_legacy_failed:${status}`)
    }

    return { billing: null, billingInfoId, log }
  }

  /** Pull buyer profile via /users/{id}. Used APENAS quando billing veio
   * sem CPF — para tentar pegar phone + first/last. NUNCA usar para email
   * (LGPD; só vem do enrichment cascade). Nunca lança. */
  async fetchBuyerUser(buyerId: number, token: string): Promise<{
    first_name: string | null
    last_name:  string | null
    phone:      string | null
  } | null> {
    try {
      const { data } = await axios.get(`${ML_BASE}/users/${buyerId}`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5_000,
      })
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

  // ── DB writers ─────────────────────────────────────────────────────────────

  /** Resolves the patch object that should be merged into `orders` after a
   * billing fetch. Always carries buyer_billing_fetched_at so the row is
   * marked "tried" even when both endpoints failed (no infinite retry). */
  private async resolveBuyer(
    externalOrderId: string,
    buyerId: number | null,
    token: string,
  ): Promise<{ patch: Record<string, unknown>; cpfFound: boolean; phoneFound: boolean; log: string[] }> {
    const result = await this.fetchCompleteBillingForOrder(externalOrderId, token)
    const billing = result.billing
    const docNumber = billing?.identification?.number ?? billing?.doc_number ?? null
    const docType   = billing?.identification?.type   ?? billing?.doc_type   ?? null
    const cleanDoc  = docNumber ? docNumber.replace(/\D/g, '') || null : null

    let userInfo: Awaited<ReturnType<typeof this.fetchBuyerUser>> = null
    if (buyerId && !cleanDoc) {
      userInfo = await this.fetchBuyerUser(buyerId, token)
    }

    const composedFromBilling = [billing?.name, billing?.last_name].filter(Boolean).join(' ').trim() || null
    const composedFromUser    = [userInfo?.first_name, userInfo?.last_name].filter(Boolean).join(' ').trim() || null
    const fullName = composedFromBilling ?? composedFromUser ?? null
    const phone    = userInfo?.phone ?? null

    const patch: Record<string, unknown> = {
      buyer_billing_fetched_at: new Date().toISOString(),
    }
    if (cleanDoc)                    patch.buyer_doc_number      = cleanDoc
    if (docType)                     patch.buyer_doc_type         = docType
    if (fullName)                    patch.buyer_name             = fullName
    if (billing?.last_name ?? userInfo?.last_name) patch.buyer_last_name = billing?.last_name ?? userInfo?.last_name ?? null
    if (result.billingInfoId)        patch.buyer_billing_info_id  = result.billingInfoId
    if (phone)                       patch.buyer_phone            = phone
    if (billing?.address)            patch.billing_address        = billing.address
    patch.billing_country = billing?.address?.country_id ?? 'BR'

    return { patch, cpfFound: !!cleanDoc, phoneFound: !!phone, log: result.log }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Count orders still missing billing info — drives the counter on the
   * "Buscar CPFs no ML" button in /clientes. */
  async countPending(): Promise<number> {
    const { count } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .is('buyer_billing_fetched_at', null)
      .not('external_order_id', 'is', null)
    return count ?? 0
  }

  /** Fetch billing for up to `limit` orders that don't have it yet.
   * Sequential at ~1 req/sec to respect ML rate-limit. */
  async fetchBatch(limit = 50): Promise<{
    processed: number
    with_cpf:  number
    with_email: number
    with_phone: number
    no_data:   number
    errors:    number
  }> {
    const empty = { processed: 0, with_cpf: 0, with_email: 0, with_phone: 0, no_data: 0, errors: 0 }

    let token: string
    try {
      ;({ token } = await this.ml.getValidToken())
    } catch {
      return empty
    }

    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, external_order_id, organization_id, raw_data')
      .is('buyer_billing_fetched_at', null)
      .not('external_order_id', 'is', null)
      .limit(limit)

    if (!orders?.length) return empty

    let withCpf = 0, withPhone = 0, noData = 0, errors = 0
    for (const o of orders) {
      const ext = o.external_order_id as string
      const buyerId = ((o.raw_data as { buyer?: { id?: number } } | null)?.buyer?.id) ?? null

      const { patch, cpfFound, phoneFound, log } = await this.resolveBuyer(ext, buyerId, token)

      const { error: upErr } = await supabaseAdmin
        .from('orders').update(patch).eq('id', o.id)

      if (upErr) { errors++; continue }
      if (cpfFound)   withCpf++
      if (phoneFound) withPhone++
      if (!cpfFound && !phoneFound) noData++

      this.logger.log(
        `[ml-sync.billing] order=${ext} cpf=${cpfFound ? 'yes' : 'no'} log=${log.join('|')}`,
      )

      await new Promise(r => setTimeout(r, 1100))
    }

    if (withCpf + withPhone + noData + errors > 0) {
      this.logger.log(
        `[ml.billing.batch] processed=${orders.length} cpf=${withCpf} phone=${withPhone} no_data=${noData} errors=${errors}`,
      )
    }
    // with_email kept at 0 — ML never returns email (LGPD); shape preserved
    // so the /clientes toast doesn't break.
    return {
      processed:  orders.length,
      with_cpf:   withCpf,
      with_email: 0,
      with_phone: withPhone,
      no_data:    noData,
      errors,
    }
  }

  /** Manual single-order refetch. Powers POST /ml/orders/:id/refetch-billing. */
  async refetchOne(externalOrderId: string): Promise<{
    ok:    boolean
    order_id: string
    buyer: {
      doc_type:        string | null
      doc_number:      string | null
      email:           string | null
      phone:           string | null
      name:            string | null
      last_name:       string | null
      billing_info_id: string | null
      billing_address: unknown
    } | null
    log?:    string[]
    message?: string
  }> {
    let token: string
    try {
      ;({ token } = await this.ml.getValidToken())
    } catch {
      return { ok: false, order_id: externalOrderId, buyer: null, message: 'Token ML inválido — reconecte a conta' }
    }

    const { data: orderRow } = await supabaseAdmin
      .from('orders')
      .select('id, raw_data')
      .eq('external_order_id', externalOrderId)
      .limit(1)
      .maybeSingle()

    const buyerId = ((orderRow?.raw_data as { buyer?: { id?: number } } | null)?.buyer?.id) ?? null

    const { patch, log } = await this.resolveBuyer(externalOrderId, buyerId, token)

    const { error } = await supabaseAdmin
      .from('orders')
      .update(patch)
      .eq('external_order_id', externalOrderId)
    if (error) {
      this.logger.error(`[ml.billing.refetch] external=${externalOrderId} db=${error.message}`)
      return { ok: false, order_id: externalOrderId, buyer: null, log, message: error.message }
    }

    this.logger.log(
      `[ml-sync.billing] order=${externalOrderId} cpf=${patch.buyer_doc_number ? 'yes' : 'no'} log=${log.join('|')}`,
    )

    return {
      ok: true,
      order_id: externalOrderId,
      log,
      buyer: {
        doc_type:        (patch.buyer_doc_type        as string | null) ?? null,
        doc_number:      (patch.buyer_doc_number      as string | null) ?? null,
        email:           null,
        phone:           (patch.buyer_phone           as string | null) ?? null,
        name:            (patch.buyer_name            as string | null) ?? null,
        last_name:       (patch.buyer_last_name       as string | null) ?? null,
        billing_info_id: (patch.buyer_billing_info_id as string | null) ?? null,
        billing_address: patch.billing_address ?? null,
      },
    }
  }

  /** Hourly cron — drains ~50/hour of unfetched orders. */
  @Cron(CronExpression.EVERY_HOUR)
  async cron() {
    try {
      await this.fetchBatch(50)
    } catch (e: unknown) {
      const err = e as { message?: string }
      this.logger.error(`[ml.billing.cron] ${err?.message}`)
    }
  }
}
