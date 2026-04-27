import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from './mercadolivre.service'

const ML_BASE = 'https://api.mercadolibre.com'

/** Pulls buyer billing info (CPF + email + phone) from ML for orders
 * that don't have it yet, then writes it back to `orders`. The DB
 * trigger `trg_sync_buyer` propagates each update into unified_customers
 * automatically — no separate write here. */
@Injectable()
export class MlBillingFetcherService {
  private readonly logger = new Logger(MlBillingFetcherService.name)

  constructor(private readonly ml: MercadolivreService) {}

  /** Hit /orders/{id}/billing_info for one order. Sends `x-version: 2` per
   * ML's recommendation. Never throws — returns the parsed fields or null. */
  async fetchOne(externalOrderId: string, token: string): Promise<{
    doc_type: string | null
    doc_number: string | null
    email: string | null
    phone: string | null
    name: string | null
  } | null> {
    try {
      const { data } = await axios.get(`${ML_BASE}/orders/${externalOrderId}/billing_info`, {
        headers: { Authorization: `Bearer ${token}`, 'x-version': '2' },
        timeout: 12_000,
      })
      const buyer    = (data?.buyer ?? {}) as Record<string, unknown>
      const billing  = (buyer.billing_info ?? {}) as Record<string, unknown>
      const phoneObj = (buyer.phone ?? {}) as Record<string, unknown>
      const phoneStr = phoneObj.area_code && phoneObj.number
        ? `${phoneObj.area_code}${phoneObj.number}`
        : ((phoneObj.number as string) ?? null)
      const billingName  = (billing.name as string | undefined) ?? null
      const composedName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || null
      return {
        doc_type:   (billing.doc_type as string)   ?? null,
        doc_number: ((billing.doc_number as string) ?? '').replace(/\D/g, '') || null,
        email:      (buyer.email as string)        ?? null,
        phone:      phoneStr ? phoneStr.replace(/\D/g, '') : null,
        name:       billingName ?? composedName,
      }
    } catch (e: any) {
      const status = e?.response?.status
      // 401/403/404 are expected for missing/inaccessible orders — silent return
      if (status === 401 || status === 403 || status === 404) return null
      this.logger.warn(`[ml.billing.fetch] order=${externalOrderId}: ${status ?? ''} ${e?.message ?? ''}`)
      return null
    }
  }

  /** Pull buyer profile via /users/{id}. Used as a fallback for phone/email
   * since billing_info often returns these blank for LGPD reasons. */
  async fetchBuyerUser(buyerId: number, token: string): Promise<{
    first_name: string | null
    last_name:  string | null
    email:      string | null
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
        email:      (data?.email      as string) ?? null,
        phone:      pickPhone(phoneObj) ?? pickPhone(altObj),
      }
    } catch {
      return null
    }
  }

  /** Manual single-order refetch. Powers POST /ml/orders/:id/refetch-billing
   * — UI button on the order detail card when buyer fields are missing. */
  async refetchOne(externalOrderId: string): Promise<{
    ok:    boolean
    order_id: string
    buyer: {
      doc_type:   string | null
      doc_number: string | null
      email:      string | null
      phone:      string | null
      name:       string | null
    } | null
    message?: string
  }> {
    let token: string
    try {
      ;({ token } = await this.ml.getValidToken())
    } catch {
      return { ok: false, order_id: externalOrderId, buyer: null, message: 'Token ML inválido — reconecte a conta' }
    }

    // Pull the order row to know the buyer_id (for /users fallback)
    const { data: orderRow } = await supabaseAdmin
      .from('orders')
      .select('id, raw_data')
      .eq('external_order_id', externalOrderId)
      .limit(1)
      .maybeSingle()

    const buyerId = ((orderRow?.raw_data as { buyer?: { id?: number } } | null)?.buyer?.id) ?? null

    const billing = await this.fetchOne(externalOrderId, token)
    let userInfo: Awaited<ReturnType<typeof this.fetchBuyerUser>> = null
    if (buyerId && (!billing?.phone || !billing?.email)) {
      userInfo = await this.fetchBuyerUser(buyerId, token)
    }

    const phone = billing?.phone ?? userInfo?.phone ?? null
    const email = billing?.email ?? userInfo?.email ?? null
    const composedFromUser = [userInfo?.first_name, userInfo?.last_name].filter(Boolean).join(' ').trim() || null
    const name  = billing?.name ?? composedFromUser ?? null

    const patch: Record<string, unknown> = {
      buyer_billing_fetched_at: new Date().toISOString(),
    }
    if (billing?.doc_number) patch.buyer_doc_number = billing.doc_number
    if (billing?.doc_type)   patch.buyer_doc_type   = billing.doc_type
    if (email)               patch.buyer_email      = email
    if (phone)               patch.buyer_phone      = phone
    if (name)                patch.buyer_name       = name

    const { error } = await supabaseAdmin
      .from('orders')
      .update(patch)
      .eq('external_order_id', externalOrderId)
    if (error) {
      this.logger.error(`[ml.billing.refetch] external=${externalOrderId} db=${error.message}`)
      return { ok: false, order_id: externalOrderId, buyer: null, message: error.message }
    }

    return {
      ok: true,
      order_id: externalOrderId,
      buyer: {
        doc_type:   billing?.doc_type   ?? null,
        doc_number: billing?.doc_number ?? null,
        email,
        phone,
        name,
      },
    }
  }

  /** Count orders still missing billing info — used by the "Buscar CPFs no ML"
   * button in /clientes to surface remaining work. */
  async countPending(): Promise<number> {
    const { count } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .is('buyer_billing_fetched_at', null)
      .not('external_order_id', 'is', null)
    return count ?? 0
  }

  /** Fetch billing for up to `limit` orders that don't have it yet.
   * Sequential (1 req/sec via small sleep) to respect ML rate limit.
   * Returns per-field hit counts so the UI can show "X CPFs / Y emails". */
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

    let withCpf = 0, withEmail = 0, withPhone = 0, noData = 0, errors = 0
    for (const o of orders) {
      const ext = o.external_order_id as string
      const billing = await this.fetchOne(ext, token)

      const buyerId = ((o.raw_data as { buyer?: { id?: number } } | null)?.buyer?.id) ?? null
      let userInfo: Awaited<ReturnType<typeof this.fetchBuyerUser>> = null
      if (buyerId && (!billing?.phone || !billing?.email)) {
        userInfo = await this.fetchBuyerUser(buyerId, token)
      }

      const phone = billing?.phone ?? userInfo?.phone ?? null
      const email = billing?.email ?? userInfo?.email ?? null
      const composedFromUser = [userInfo?.first_name, userInfo?.last_name].filter(Boolean).join(' ').trim() || null
      const name  = billing?.name ?? composedFromUser ?? null

      const patch: Record<string, unknown> = {
        buyer_billing_fetched_at: new Date().toISOString(),
      }
      if (billing?.doc_number) patch.buyer_doc_number = billing.doc_number
      if (billing?.doc_type)   patch.buyer_doc_type   = billing.doc_type
      if (email)               patch.buyer_email      = email
      if (phone)               patch.buyer_phone      = phone
      if (name)                patch.buyer_name       = name

      const { error: upErr } = await supabaseAdmin
        .from('orders').update(patch).eq('id', o.id)

      if (upErr) { errors++; continue }
      if (billing?.doc_number) withCpf++
      if (email) withEmail++
      if (phone) withPhone++
      if (!billing?.doc_number && !email && !phone) noData++

      // 1 req/sec budget for the ML billing endpoint
      await new Promise(r => setTimeout(r, 1100))
    }

    if (withCpf + withEmail + withPhone + noData + errors > 0) {
      this.logger.log(
        `[ml.billing.batch] processed=${orders.length} cpf=${withCpf} email=${withEmail} phone=${withPhone} no_data=${noData} errors=${errors}`,
      )
    }
    return {
      processed:  orders.length,
      with_cpf:   withCpf,
      with_email: withEmail,
      with_phone: withPhone,
      no_data:    noData,
      errors,
    }
  }

  /** Hourly cron — fetches up to 50 unfetched orders. With ~13.5k orders
   * outstanding the backfill takes about 4-5 hours of cron + a manual
   * "Buscar agora" trigger from the UI for an immediate top-up. */
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
