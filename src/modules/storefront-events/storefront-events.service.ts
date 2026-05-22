import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'

const ACTIVE_BRIDGE_URL = process.env.ACTIVE_BRIDGE_URL ?? 'https://api.active.eclick.app.br'
const ACTIVE_BRIDGE_SECRET = process.env.ACTIVE_AUTOMATION_BRIDGE_SECRET ?? ''

const ALLOWED_EVENT_TYPES = new Set([
  'page_view', 'product_view', 'add_to_cart', 'begin_checkout', 'purchase',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Injectable()
export class StorefrontEventsService {
  private readonly logger = new Logger(StorefrontEventsService.name)

  /** AI1 — ingest de eventos da vitrine (beacon público, fire-and-forget).
   *  Nunca lança: beacon não pode quebrar a navegação do cliente. */
  async track(input: {
    slug:      string
    sessionId: string
    events:    Array<{ type: string; productId?: string; value?: number; source?: string; meta?: Record<string, unknown> }>
    ipHash?:   string | null
  }): Promise<{ ok: true; inserted: number }> {
    try {
      const session = (input.sessionId ?? '').trim().slice(0, 80)
      if (!session || !input.slug) return { ok: true, inserted: 0 }
      const { data: store } = await supabaseAdmin
        .from('store_config')
        .select('organization_id')
        .eq('store_slug', input.slug).eq('status', 'active')
        .maybeSingle()
      if (!store) return { ok: true, inserted: 0 }
      const orgId = (store as { organization_id: string }).organization_id

      const rows = (input.events ?? [])
        .slice(0, 20)
        .filter(e => e && ALLOWED_EVENT_TYPES.has(e.type))
        .map(e => ({
          organization_id: orgId,
          store_slug:      input.slug,
          session_id:      session,
          event_type:      e.type,
          product_id:      (typeof e.productId === 'string' && UUID_RE.test(e.productId)) ? e.productId : null,
          value:           typeof e.value === 'number' && Number.isFinite(e.value) ? e.value : null,
          source:          (e.source ?? '').toString().trim().slice(0, 60) || null,
          meta:            (e.meta && typeof e.meta === 'object') ? e.meta : {},
          client_ip_hash:  input.ipHash ?? null,
        }))
      if (!rows.length) return { ok: true, inserted: 0 }
      const { error } = await supabaseAdmin.from('storefront_events').insert(rows)
      if (error) this.logger.warn(`[events.track] insert falhou: ${error.message}`)
      return { ok: true, inserted: rows.length }
    } catch (e) {
      this.logger.warn(`[events.track] ${(e as Error).message}`)
      return { ok: true, inserted: 0 }
    }
  }

  /**
   * Dispara `cart_abandoned` no Active. O Active decide se manda WhatsApp
   * agora (15min/1h/24h/72h depending na config do lojista).
   *
   * Idempotencia: usa cart_id ou customer_phone+items_hash como dedup_key
   * no Active. Aqui no SaaS so encaminhamos.
   */
  async triggerCartAbandoned(input: {
    slug:            string
    customer_phone?: string
    customer_email?: string
    customer_name?:  string
    items:           Array<{ productId: string; name: string; price: number; qty: number }>
    subtotal:        number
    cart_id?:        string
  }): Promise<{ sent: boolean; reason?: string }> {
    if (!ACTIVE_BRIDGE_SECRET) {
      this.logger.warn('[storefront-events] ACTIVE_AUTOMATION_BRIDGE_SECRET nao configurado — skip')
      return { sent: false, reason: 'bridge_not_configured' }
    }
    if (!input.customer_phone && !input.customer_email) {
      return { sent: false, reason: 'no_contact' }
    }

    // Resolve organization_id via slug
    const { data: store } = await supabaseAdmin
      .from('store_config')
      .select('organization_id, store_name')
      .eq('store_slug', input.slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!store) return { sent: false, reason: 'store_not_found' }
    const { organization_id, store_name } = store as { organization_id: string; store_name: string }

    try {
      await axios.post(
        `${ACTIVE_BRIDGE_URL}/commerce/automation-bridge/trigger-cart-recovery`,
        {
          organization_id,
          store_name,
          customer: {
            phone: input.customer_phone,
            email: input.customer_email,
            name:  input.customer_name,
          },
          items:    input.items,
          subtotal: input.subtotal,
          cart_id:  input.cart_id,
          source:   'storefront_v3',
        },
        {
          headers:  { 'X-Automation-Bridge-Token': ACTIVE_BRIDGE_SECRET, 'Content-Type': 'application/json' },
          timeout:  10_000,
        },
      )
      this.logger.log(`[storefront-events] cart_abandoned enviado org=${organization_id} phone=${input.customer_phone ? '***' : '-'}`)
      return { sent: true }
    } catch (e) {
      const err = e as { response?: { status?: number; data?: unknown }; message?: string }
      this.logger.error(`[storefront-events] falha cart_abandoned: ${err.message ?? 'unknown'} (status=${err.response?.status ?? '?'})`)
      return { sent: false, reason: 'bridge_error' }
    }
  }
}
