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

  /** Hit /orders/{id}/billing_info for one order. Never throws —
   * returns the parsed fields or null. */
  async fetchOne(externalOrderId: string, token: string): Promise<{
    doc_type: string | null
    doc_number: string | null
    email: string | null
    phone: string | null
    name: string | null
  } | null> {
    try {
      const { data } = await axios.get(`${ML_BASE}/orders/${externalOrderId}/billing_info`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 12_000,
      })
      const buyer    = (data?.buyer ?? {}) as Record<string, unknown>
      const billing  = (buyer.billing_info ?? {}) as Record<string, unknown>
      const phoneObj = (buyer.phone ?? {}) as Record<string, unknown>
      const phoneStr = phoneObj.area_code && phoneObj.number
        ? `${phoneObj.area_code}${phoneObj.number}`
        : ((phoneObj.number as string) ?? null)
      const fullName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ').trim() || null
      return {
        doc_type:   (billing.doc_type as string)   ?? null,
        doc_number: ((billing.doc_number as string) ?? '').replace(/\D/g, '') || null,
        email:      (buyer.email as string)        ?? null,
        phone:      phoneStr ? phoneStr.replace(/\D/g, '') : null,
        name:       fullName,
      }
    } catch (e: any) {
      const status = e?.response?.status
      // 401/403/404 are expected for missing/inaccessible orders — silent return
      if (status === 401 || status === 403 || status === 404) return null
      this.logger.warn(`[ml.billing.fetch] order=${externalOrderId}: ${status ?? ''} ${e?.message ?? ''}`)
      return null
    }
  }

  /** Fetch billing for up to `limit` orders that don't have it yet.
   * Sequential (1 req/sec via small sleep) to respect ML rate limit.
   * Returns counts of processed / hits / no-data. */
  async fetchBatch(limit = 50): Promise<{ processed: number; hits: number; no_data: number; errors: number }> {
    let token: string
    try {
      ;({ token } = await this.ml.getValidToken())
    } catch {
      return { processed: 0, hits: 0, no_data: 0, errors: 0 }
    }

    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, external_order_id, organization_id')
      .is('buyer_billing_fetched_at', null)
      .not('external_order_id', 'is', null)
      .limit(limit)

    if (!orders?.length) return { processed: 0, hits: 0, no_data: 0, errors: 0 }

    let hits = 0, noData = 0, errors = 0
    for (const o of orders) {
      const ext = o.external_order_id as string
      const billing = await this.fetchOne(ext, token)

      const patch: Record<string, unknown> = {
        buyer_billing_fetched_at: new Date().toISOString(),
      }
      if (billing?.doc_number) patch.buyer_doc_number = billing.doc_number
      if (billing?.doc_type)   patch.buyer_doc_type   = billing.doc_type
      if (billing?.email)      patch.buyer_email      = billing.email
      if (billing?.phone)      patch.buyer_phone      = billing.phone
      if (billing?.name)       patch.buyer_name       = billing.name

      const { error: upErr } = await supabaseAdmin
        .from('orders').update(patch).eq('id', o.id)

      if (upErr) { errors++; continue }
      if (billing?.doc_number || billing?.email || billing?.phone) hits++
      else noData++

      // 1 req/sec budget for the ML billing endpoint
      await new Promise(r => setTimeout(r, 1100))
    }

    if (hits + noData + errors > 0) {
      this.logger.log(`[ml.billing.batch] processed=${orders.length} hits=${hits} no_data=${noData} errors=${errors}`)
    }
    return { processed: orders.length, hits, no_data: noData, errors }
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
