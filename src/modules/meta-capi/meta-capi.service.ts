import { Injectable, Logger } from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'

const GRAPH = 'https://graph.facebook.com/v21.0'

interface CapiConfigRaw {
  dataset_id: string | null
  access_token: string | null
}

/**
 * MetaCapiService — Conversions API (server-side) do Meta.
 *
 * Roda no SaaS porque é aqui que o pedido vira "paid" (storefront_orders).
 * No momento do pagamento, dispara um evento Purchase server-to-server pro
 * dataset/pixel do Meta — atribuição resiliente a iOS/adblock.
 *
 * Config por org em api_credentials (provider='meta_capi', key_name in
 * dataset_id|access_token). PII (e-mail/telefone) é hasheada SHA256 e nunca
 * logada. event_id = orderId pra deduplicar com o pixel do navegador.
 *
 * Gated: sem config → no-op silencioso. Best-effort: NUNCA quebra o checkout.
 */
@Injectable()
export class MetaCapiService {
  private readonly logger = new Logger(MetaCapiService.name)

  // ── Config ──────────────────────────────────────────────────

  /** Status da config pra UI — sem expor o token. */
  async getConfig(orgId: string): Promise<{ dataset_id: string | null; has_token: boolean }> {
    const cfg = await this.resolveConfigRaw(orgId)
    return { dataset_id: cfg.dataset_id, has_token: !!cfg.access_token }
  }

  /** Salva dataset_id e/ou access_token (preserva o que não veio). */
  async setConfig(
    orgId: string,
    userId: string,
    body: { dataset_id?: string; access_token?: string },
  ): Promise<{ dataset_id: string | null; has_token: boolean }> {
    const upserts: Array<{ key_name: string; key_value: string; key_preview: string }> = []
    if (body.dataset_id !== undefined) {
      upserts.push({ key_name: 'dataset_id', key_value: body.dataset_id, key_preview: body.dataset_id.slice(0, 12) })
    }
    if (body.access_token) {
      upserts.push({ key_name: 'access_token', key_value: body.access_token, key_preview: `••••${body.access_token.slice(-4)}` })
    }
    for (const u of upserts) {
      await supabaseAdmin.from('api_credentials')
        .delete().eq('organization_id', orgId).eq('provider', 'meta_capi').eq('key_name', u.key_name)
      await supabaseAdmin.from('api_credentials').insert({
        organization_id: orgId, user_id: userId, provider: 'meta_capi',
        key_name: u.key_name, key_value: u.key_value, key_preview: u.key_preview, is_active: true,
      })
    }
    return this.getConfig(orgId)
  }

  private async resolveConfigRaw(orgId: string): Promise<CapiConfigRaw> {
    const { data } = await supabaseAdmin
      .from('api_credentials')
      .select('key_name, key_value')
      .eq('organization_id', orgId)
      .eq('provider', 'meta_capi')
      .eq('is_active', true)
    const rows = (data ?? []) as Array<{ key_name: string; key_value: string }>
    return {
      dataset_id: rows.find((r) => r.key_name === 'dataset_id')?.key_value ?? null,
      access_token: rows.find((r) => r.key_name === 'access_token')?.key_value ?? null,
    }
  }

  // ── Envio ───────────────────────────────────────────────────

  /** Dispara Purchase pro CAPI a partir de um storefront_order pago. */
  async sendPurchaseForOrder(orderId: string): Promise<{ sent: boolean; reason?: string }> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, total, customer, items')
        .eq('id', orderId)
        .maybeSingle()
      if (!order) return { sent: false, reason: 'order não encontrado' }

      const o = order as {
        organization_id: string
        total: number | string | null
        customer: Record<string, unknown> | null
        items: Array<Record<string, unknown>> | null
      }
      const cfg = await this.resolveConfigRaw(o.organization_id)
      if (!cfg.dataset_id || !cfg.access_token) return { sent: false, reason: 'CAPI não configurado' }

      const customer = o.customer ?? {}
      const user_data: Record<string, unknown> = {}
      const em = normEmail(customer.email as string | undefined)
      const ph = normPhone(customer.phone as string | undefined)
      if (em) user_data.em = [sha256(em)]
      if (ph) user_data.ph = [sha256(ph)]

      const contentIds = (o.items ?? [])
        .map((it) => (it.sku ?? it.product_id ?? it.id) as string | undefined)
        .filter(Boolean)

      const event = {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: orderId, // dedup com o pixel do navegador
        user_data,
        custom_data: {
          currency: 'BRL',
          value: Number(o.total) || 0,
          content_type: 'product',
          content_ids: contentIds,
          order_id: orderId,
        },
      }

      const res = await fetch(`${GRAPH}/${cfg.dataset_id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [event], access_token: cfg.access_token }),
      })
      if (!res.ok) {
        this.logger.warn(`[capi] order=${orderId} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        return { sent: false, reason: `HTTP ${res.status}` }
      }
      this.logger.log(`[capi] Purchase enviado order=${orderId} value=${event.custom_data.value}`)
      return { sent: true }
    } catch (e) {
      this.logger.warn(`[capi] falha order=${orderId}: ${e instanceof Error ? e.message : String(e)}`)
      return { sent: false, reason: 'erro' }
    }
  }

  /** Envia um evento de teste (usa test_event_code do Events Manager). */
  async sendTest(orgId: string, testEventCode?: string): Promise<{ sent: boolean; reason?: string }> {
    const cfg = await this.resolveConfigRaw(orgId)
    if (!cfg.dataset_id || !cfg.access_token) return { sent: false, reason: 'CAPI não configurado' }
    const body: Record<string, unknown> = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: `test_${Math.floor(Date.now() / 1000)}`,
        user_data: { em: [sha256('teste@eclick.app.br')] },
        custom_data: { currency: 'BRL', value: 1.0, content_type: 'product' },
      }],
      access_token: cfg.access_token,
    }
    if (testEventCode) body.test_event_code = testEventCode
    const res = await fetch(`${GRAPH}/${cfg.dataset_id}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
    return { sent: true }
  }
}

// ── PII helpers ───────────────────────────────────────────────

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex')
}
function normEmail(e: string | undefined): string | null {
  if (!e) return null
  const t = String(e).trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t) ? t : null
}
function normPhone(p: string | undefined): string | null {
  if (!p) return null
  let d = String(p).replace(/\D/g, '')
  if (!d) return null
  if (d.length <= 11) d = `55${d}`
  return d.length >= 12 && d.length <= 15 ? d : null
}
