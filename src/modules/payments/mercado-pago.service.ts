import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import axios from 'axios'
import { CredentialsService } from '../credentials/credentials.service'
import type { GatewayCheckoutResult, StorefrontOrder } from './types'

/**
 * Mercado Pago — cria Preference (Checkout Pro).
 *
 * API: https://api.mercadopago.com/checkout/preferences
 *
 * Credencial: providers='mercadopago', key_name='MP_ACCESS_TOKEN' (per-org,
 * com fallback global pra ambiente de teste). Token de PROD começa com
 * APP_USR; token de teste com TEST.
 *
 * Webhook: MP chama `notification_url` com query `?topic=payment&id=X`.
 * Pra confirmar valor real, o handler busca GET /v1/payments/{id} com o
 * mesmo token e atualiza `storefront_orders` por `external_reference`.
 */
@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name)
  private readonly base = 'https://api.mercadopago.com'

  constructor(private readonly credentials: CredentialsService) {}

  /** Pega o access_token do MP da org (org-specific → fallback global). */
  async getAccessToken(orgId: string): Promise<string> {
    const key =
      (await this.credentials.getDecryptedKey(orgId, 'mercadopago', 'MP_ACCESS_TOKEN').catch(() => null)) ??
      (await this.credentials.getDecryptedKey(null,  'mercadopago', 'MP_ACCESS_TOKEN').catch(() => null))
    if (!key) {
      throw new BadRequestException(
        'Mercado Pago não configurado. Adicione MP_ACCESS_TOKEN nas Configurações.',
      )
    }
    return key
  }

  /** Cria uma Preference no MP e retorna o init_point pra redirect. */
  async createCheckout(
    orgId: string,
    order: StorefrontOrder,
    urls: { success: string; failure: string; pending: string; webhook: string },
  ): Promise<GatewayCheckoutResult> {
    const token = await this.getAccessToken(orgId)

    const body: Record<string, unknown> = {
      items: order.items.map(i => ({
        id:           i.productId,
        title:        i.name,
        quantity:     i.qty,
        unit_price:   Number(i.price),
        currency_id:  'BRL',
        picture_url:  i.imageUrl,
      })),
      payer: {
        name:  order.customer.name?.split(' ')[0] ?? order.customer.name,
        email: order.customer.email,
        phone: order.customer.phone
          ? { number: order.customer.phone.replace(/\D/g, '') }
          : undefined,
        identification: order.customer.doc
          ? { type: order.customer.doc.replace(/\D/g, '').length > 11 ? 'CNPJ' : 'CPF', number: order.customer.doc.replace(/\D/g, '') }
          : undefined,
      },
      back_urls: {
        success: urls.success,
        failure: urls.failure,
        pending: urls.pending,
      },
      auto_return:        'approved',
      notification_url:   urls.webhook,
      external_reference: order.id,
      statement_descriptor: 'ECLICK STORE',
    }

    try {
      const res = await axios.post<{ id: string; init_point: string; sandbox_init_point?: string }>(
        `${this.base}/checkout/preferences`,
        body,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15_000 },
      )
      // Em ambiente sandbox (token TEST-...), MP exige sandbox_init_point
      const isSandbox = token.startsWith('TEST')
      const initPoint = (isSandbox && res.data.sandbox_init_point) || res.data.init_point
      return { sessionId: res.data.id, initPoint }
    } catch (e) {
      const msg = axios.isAxiosError(e)
        ? `HTTP ${e.response?.status} ${JSON.stringify(e.response?.data).slice(0, 200)}`
        : (e as Error).message
      this.logger.error(`[mp.checkout] org=${orgId} order=${order.id}: ${msg}`)
      throw new BadRequestException('Não foi possível criar a cobrança no Mercado Pago. Tente de novo.')
    }
  }

  /** Webhook: dado um payment_id, busca o pagamento e devolve o status real
   *  + external_reference (= storefront_orders.id). Idempotente. */
  async fetchPayment(orgId: string, paymentId: string): Promise<{
    status:             string
    statusDetail:       string | null
    externalReference:  string | null
    raw:                Record<string, unknown>
  }> {
    const token = await this.getAccessToken(orgId)
    try {
      const res = await axios.get<Record<string, unknown>>(
        `${this.base}/v1/payments/${encodeURIComponent(paymentId)}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10_000 },
      )
      const d = res.data
      return {
        status:             String(d.status ?? 'unknown'),
        statusDetail:       (d.status_detail as string | null) ?? null,
        externalReference:  (d.external_reference as string | null) ?? null,
        raw:                d,
      }
    } catch (e) {
      const msg = axios.isAxiosError(e) ? `HTTP ${e.response?.status}` : (e as Error).message
      this.logger.warn(`[mp.fetchPayment] org=${orgId} pay=${paymentId}: ${msg}`)
      throw new BadRequestException('Pagamento não encontrado no Mercado Pago.')
    }
  }
}
