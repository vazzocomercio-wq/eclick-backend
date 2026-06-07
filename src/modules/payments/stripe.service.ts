import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { CredentialsService } from '../credentials/credentials.service'
import type { GatewayCheckoutResult, StorefrontOrder } from './types'

/**
 * Stripe — cria Checkout Session.
 *
 * API: https://api.stripe.com/v1/checkout/sessions (form-urlencoded).
 *
 * Credencial: providers='stripe', key_name='STRIPE_SECRET_KEY' (per-org
 * com fallback global). Suporta sk_test_* (sandbox) e sk_live_*.
 *
 * Webhook: Stripe envia POST com signature `Stripe-Signature` (HMAC do
 * payload com endpoint_secret). O handler valida assinatura, le o evento
 * `checkout.session.completed` ou `payment_intent.succeeded` e atualiza
 * `storefront_orders` por `metadata.storefront_order_id`.
 *
 * Implementacao via axios (sem SDK) — pra Checkout Session basico funciona
 * 100%. Pra eventos avancados (split, refund, subscriptions), refator pro
 * SDK fica natural.
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name)
  private readonly base = 'https://api.stripe.com/v1'

  constructor(private readonly credentials: CredentialsService) {}

  /** Status de configuração do Stripe pra org (sem expor a chave). */
  async isConfigured(orgId: string): Promise<{ configured: boolean; scope: 'org' | 'global' | null }> {
    const org = await this.credentials.getDecryptedKey(orgId, 'stripe', 'STRIPE_SECRET_KEY').catch(() => null)
    if (org) return { configured: true, scope: 'org' }
    const global = await this.credentials.getDecryptedKey(null, 'stripe', 'STRIPE_SECRET_KEY').catch(() => null)
    if (global) return { configured: true, scope: 'global' }
    return { configured: false, scope: null }
  }

  async getSecretKey(orgId: string): Promise<string> {
    const key =
      (await this.credentials.getDecryptedKey(orgId, 'stripe', 'STRIPE_SECRET_KEY').catch(() => null)) ??
      (await this.credentials.getDecryptedKey(null,  'stripe', 'STRIPE_SECRET_KEY').catch(() => null))
    if (!key) {
      throw new BadRequestException(
        'Stripe não configurado. Adicione STRIPE_SECRET_KEY nas Configurações.',
      )
    }
    return key
  }

  async getWebhookSecret(orgId: string): Promise<string | null> {
    return (await this.credentials.getDecryptedKey(orgId, 'stripe', 'STRIPE_WEBHOOK_SECRET').catch(() => null))
        ?? (await this.credentials.getDecryptedKey(null,  'stripe', 'STRIPE_WEBHOOK_SECRET').catch(() => null))
  }

  /** Cria Checkout Session e devolve a URL pra redirect. */
  async createCheckout(
    orgId: string,
    order: StorefrontOrder,
    urls: { success: string; cancel: string },
  ): Promise<GatewayCheckoutResult> {
    const key = await this.getSecretKey(orgId)

    // Stripe usa form-urlencoded com keys "nested" tipo line_items[0][price_data][...]
    const form = new URLSearchParams()
    form.append('mode', 'payment')
    form.append('success_url', `${urls.success}?session_id={CHECKOUT_SESSION_ID}`)
    form.append('cancel_url',  urls.cancel)
    form.append('metadata[storefront_order_id]', order.id)
    form.append('metadata[organization_id]',     order.organization_id)
    form.append('metadata[store_slug]',          order.store_slug)
    if (order.customer.email) form.append('customer_email', order.customer.email)

    order.items.forEach((it, i) => {
      const cents = Math.round(it.price * 100)
      form.append(`line_items[${i}][price_data][currency]`,            'brl')
      form.append(`line_items[${i}][price_data][unit_amount]`,         String(cents))
      form.append(`line_items[${i}][price_data][product_data][name]`,  it.name)
      if (it.imageUrl) form.append(`line_items[${i}][price_data][product_data][images][0]`, it.imageUrl)
      form.append(`line_items[${i}][quantity]`,                        String(it.qty))
    })

    try {
      const res = await axios.post<{ id: string; url: string }>(
        `${this.base}/checkout/sessions`,
        form.toString(),
        {
          headers: {
            Authorization:    `Bearer ${key}`,
            'Content-Type':   'application/x-www-form-urlencoded',
          },
          timeout: 15_000,
        },
      )
      return { sessionId: res.data.id, initPoint: res.data.url }
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? `HTTP ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`
        : (e as Error).message
      this.logger.error(`[stripe.checkout] org=${orgId} order=${order.id}: ${msg}`)
      throw new BadRequestException('Não foi possível criar a cobrança no Stripe. Tente de novo.')
    }
  }

  /** Recupera uma checkout session — usado pelo webhook OU pelo retorno
   *  /sucesso (frontend passa session_id na URL). */
  async fetchSession(orgId: string, sessionId: string): Promise<{
    status:        string
    paymentStatus: string
    paymentIntent: string | null
    metadata:      Record<string, string>
    raw:           Record<string, unknown>
  }> {
    const key = await this.getSecretKey(orgId)
    try {
      const res = await axios.get<Record<string, unknown>>(
        `${this.base}/checkout/sessions/${encodeURIComponent(sessionId)}`,
        { headers: { Authorization: `Bearer ${key}` }, timeout: 10_000 },
      )
      const d = res.data
      return {
        status:        String(d.status ?? 'unknown'),
        paymentStatus: String(d.payment_status ?? 'unknown'),
        paymentIntent: (d.payment_intent as string | null) ?? null,
        metadata:      (d.metadata as Record<string, string>) ?? {},
        raw:           d,
      }
    } catch (e) {
      const msg = axios.isAxiosError(e) ? `HTTP ${e.response?.status}` : (e as Error).message
      this.logger.warn(`[stripe.fetchSession] org=${orgId} sess=${sessionId}: ${msg}`)
      throw new BadRequestException('Sessão não encontrada no Stripe.')
    }
  }

  /** Verifica HMAC do webhook (Stripe-Signature header).
   *  Retorna true se a assinatura bate; false caso contrario. */
  async verifyWebhookSignature(
    orgId: string,
    rawBody: string,
    signatureHeader: string,
  ): Promise<boolean> {
    const secret = await this.getWebhookSecret(orgId)
    if (!secret) {
      this.logger.warn('[stripe.webhook] STRIPE_WEBHOOK_SECRET nao configurado — pulando verificacao (NAO usar em prod)')
      return process.env.NODE_ENV !== 'production'
    }
    // Stripe-Signature: t=TIMESTAMP,v1=HMAC
    const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, p) => {
      const [k, v] = p.split('=')
      if (k && v) acc[k.trim()] = v.trim()
      return acc
    }, {})
    const timestamp = parts['t']
    const sig = parts['v1']
    if (!timestamp || !sig) return false

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require('crypto') as typeof import('crypto')
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')

    // timing-safe compare
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }
}
