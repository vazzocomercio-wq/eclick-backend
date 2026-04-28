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
   * marked "tried" even when both endpoints failed (no infinite retry).
   *
   * IMPORTANT — ML billing shape:
   *   { identification: { type, number }, name, last_name, address: { ... } }
   * NOT { doc_type, doc_number }. The legacy fallback parity is kept just
   * in case but the canonical path is `identification.{type,number}`. */
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
    const lastName = billing?.last_name ?? userInfo?.last_name ?? null

    // Step 1 — log what we PARSED out of the ML response so we can verify
    // the field paths are right when the row ends up empty in the DB.
    this.logger.log(
      `[ml-sync.billing.parsed] order=${externalOrderId} ${JSON.stringify({
        billing_info_id: result.billingInfoId,
        doc_type:        docType,
        doc_number:      cleanDoc,
        name:            billing?.name        ?? null,
        last_name:       billing?.last_name   ?? null,
        composed_name:   fullName,
        has_address:     !!billing?.address,
      })}`,
    )

    const patch: Record<string, unknown> = {
      buyer_billing_fetched_at: new Date().toISOString(),
    }
    if (cleanDoc)              patch.buyer_doc_number      = cleanDoc
    if (docType)               patch.buyer_doc_type        = docType
    if (fullName)              patch.buyer_name            = fullName
    if (lastName)              patch.buyer_last_name       = lastName
    if (result.billingInfoId)  patch.buyer_billing_info_id = result.billingInfoId
    if (phone)                 patch.buyer_phone           = phone
    if (billing?.address)      patch.billing_address       = billing.address
    patch.billing_country = billing?.address?.country_id ?? 'BR'

    // Step 2 — log the EXACT payload we're about to UPSERT (no surprises).
    this.logger.log(`[ml-sync.billing.upsert] order=${externalOrderId} ${JSON.stringify(patch)}`)

    return { patch, cpfFound: !!cleanDoc, phoneFound: !!phone, log: result.log }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Resets buyer_billing_fetched_at = NULL on rows that were marked tried
   * but ended up with NULL doc_number — typically because they were
   * processed by an older parser that read billing.doc_number instead of
   * billing.identification.number. Re-runs the cron pipeline next tick.
   *
   * Defaults to safe mode: only resets rows that have NO doc_number, so
   * successful refetches are never undone. Pass forceAll=true to reset
   * every billed row (use with care — burns ML quota). */
  async resetBillingFetched(opts: { forceAll?: boolean } = {}): Promise<{ reset: number }> {
    const onlyMissingCpf = !opts.forceAll

    let q = supabaseAdmin
      .from('orders')
      .update({ buyer_billing_fetched_at: null })
      .not('buyer_billing_fetched_at', 'is', null)
    if (onlyMissingCpf) q = q.is('buyer_doc_number', null)

    const { data, error } = await q.select('id')
    if (error) {
      this.logger.error(`[ml.billing.reset] ${error.message}`)
      throw new Error(error.message)
    }
    const reset = data?.length ?? 0
    this.logger.log(`[ml.billing.reset] ${reset} pedidos zerados (forceAll=${!!opts.forceAll})`)
    return { reset }
  }

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

  /** Debug helper — runs all 3 ML calls (GET /orders/{id}, the NEW
   * billing-info endpoint when an id is present, and the LEGACY
   * /orders/{id}/billing_info) and returns full responses + headers so we
   * can inspect why CPF isn't being captured. Never throws. Reads ZERO
   * from the DB and writes nothing — safe to call from a UI button. */
  async debugBilling(externalOrderId: string): Promise<{
    order_id: string
    log: Array<Record<string, unknown>>
  }> {
    const log: Array<Record<string, unknown>> = []

    let token: string
    try {
      ;({ token } = await this.ml.getValidToken())
    } catch (e: unknown) {
      log.push({ step: 'getValidToken', error: (e as { message?: string })?.message ?? 'erro' })
      return { order_id: externalOrderId, log }
    }

    // PASSO 1 — GET /orders/{id}
    let billingInfoId: string | null = null
    let buyerId: number | null = null
    try {
      const res = await axios.get(`${ML_BASE}/orders/${externalOrderId}`, {
        headers: { Authorization: `Bearer ${token}`, 'x-version': '2' },
        timeout: 10_000,
      })
      const data: any = res.data
      const buyer = data?.buyer ?? {}
      billingInfoId = buyer?.billing_info?.id ?? null
      buyerId = buyer?.id ?? null
      log.push({
        step: 'GET /orders/{id}',
        status: res.status,
        keys: Object.keys(data ?? {}),
        buyer_keys: Object.keys(buyer ?? {}),
        buyer_id: buyer?.id ?? null,
        buyer_nickname: buyer?.nickname ?? null,
        buyer_billing_info: buyer?.billing_info ?? null,
        buyer_billing_info_id: billingInfoId,
        buyer_full: buyer,
      })
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: unknown }; message?: string }
      log.push({
        step: 'GET /orders/{id}',
        status: err?.response?.status ?? null,
        error:  err?.response?.data ?? null,
        message: err?.message ?? null,
      })
    }

    // PASSO 2 — NOVO endpoint, só se temos billing_info_id
    if (billingInfoId) {
      try {
        const res2 = await axios.get(
          `${ML_BASE}/orders/billing-info/MLB/${billingInfoId}`,
          { headers: { Authorization: `Bearer ${token}`, 'x-version': '2' }, timeout: 10_000 },
        )
        const data: any = res2.data
        log.push({
          step: 'GET /orders/billing-info/MLB/{id}',
          status: res2.status,
          keys: Object.keys(data ?? {}),
          billing_info: data?.buyer?.billing_info ?? data?.billing_info ?? null,
          full_response: data,
        })
      } catch (e: unknown) {
        const err = e as { response?: { status?: number; data?: unknown }; message?: string }
        log.push({
          step: 'GET /orders/billing-info/MLB/{id}',
          billing_info_id: billingInfoId,
          status: err?.response?.status ?? null,
          error:  err?.response?.data ?? null,
          message: err?.message ?? null,
        })
      }
    } else {
      log.push({ step: 'skip:NEW endpoint', reason: 'sem buyer.billing_info.id na resposta de /orders/{id}' })
    }

    // PASSO 2B — endpoint LEGADO (sempre roda em debug, pra comparar)
    try {
      const resLegacy = await axios.get(
        `${ML_BASE}/orders/${externalOrderId}/billing_info`,
        { headers: { Authorization: `Bearer ${token}`, 'x-version': '2' }, timeout: 10_000 },
      )
      const data: any = resLegacy.data
      log.push({
        step: 'GET /orders/{id}/billing_info (legacy)',
        status: resLegacy.status,
        keys: Object.keys(data ?? {}),
        billing_info: data?.buyer?.billing_info ?? null,
        full_response: data,
      })
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: unknown }; message?: string }
      log.push({
        step: 'GET /orders/{id}/billing_info (legacy)',
        status: err?.response?.status ?? null,
        error:  err?.response?.data ?? null,
        message: err?.message ?? null,
      })
    }

    // PASSO 3 — /users/{buyer_id} pra checar se tem phone disponível
    if (buyerId) {
      try {
        const resUser = await axios.get(`${ML_BASE}/users/${buyerId}`, {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 5_000,
        })
        const data: any = resUser.data
        log.push({
          step: 'GET /users/{buyer_id}',
          status: resUser.status,
          first_name: data?.first_name ?? null,
          last_name:  data?.last_name  ?? null,
          phone:      data?.phone ?? null,
          alternative_phone: data?.alternative_phone ?? null,
          // intencionalmente NÃO logamos email — LGPD e ML quase nunca retorna
        })
      } catch (e: unknown) {
        const err = e as { response?: { status?: number; data?: unknown }; message?: string }
        log.push({
          step: 'GET /users/{buyer_id}',
          buyer_id: buyerId,
          status: err?.response?.status ?? null,
          error:  err?.response?.data ?? null,
          message: err?.message ?? null,
        })
      }
    } else {
      log.push({ step: 'skip:GET /users', reason: 'sem buyer.id' })
    }

    return { order_id: externalOrderId, log }
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
