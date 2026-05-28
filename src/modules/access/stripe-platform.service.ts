import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import * as crypto from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { AccessService } from './access.service'

/**
 * F17-A5 · Integração Stripe Subscriptions pra plataforma e-Click.
 *
 * NÃO confundir com payments/stripe.service.ts (que cuida do checkout
 * de PRODUTOS da Loja Própria de cada cliente). Esse aqui é pra cobrar
 * ASSINATURA da nossa plataforma, usando credencial da PLATAFORMA
 * (STRIPE_PLATFORM_SECRET_KEY env) — não credencial por org.
 *
 * Fluxo:
 *  1. Visitante preenche /solicitar-acesso (cria access_request)
 *  2. Frontend chama POST /access/checkout/stripe { request_id }
 *  3. Backend cria Stripe Checkout Session mode=subscription com o
 *     stripe_price_id do plano escolhido + metadata.access_request_id
 *  4. Devolve checkout URL pro frontend redirecionar
 *  5. Stripe envia webhook checkout.session.completed → backend chama
 *     AccessService.approve() automático (cria auth.user + org + sub)
 */
@Injectable()
export class StripePlatformService {
  private readonly logger = new Logger(StripePlatformService.name)
  private readonly base = 'https://api.stripe.com/v1'

  constructor(private readonly access: AccessService) {}

  private getSecretKey(): string {
    const key = process.env.STRIPE_PLATFORM_SECRET_KEY
    if (!key) throw new BadRequestException('STRIPE_PLATFORM_SECRET_KEY não configurada.')
    return key
  }

  private getWebhookSecret(): string {
    const key = process.env.STRIPE_PLATFORM_WEBHOOK_SECRET
    if (!key) throw new BadRequestException('STRIPE_PLATFORM_WEBHOOK_SECRET não configurada.')
    return key
  }

  /** POST form-urlencoded pra Stripe API. Aceita objetos nested via
   *  brackets (igual JS de form data Stripe). */
  private async stripePost(path: string, body: Record<string, unknown>): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    const form = new URLSearchParams()
    const append = (prefix: string, value: unknown) => {
      if (value === null || value === undefined) return
      if (typeof value === 'object' && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) append(`${prefix}[${k}]`, v)
      } else if (Array.isArray(value)) {
        value.forEach((v, i) => append(`${prefix}[${i}]`, v))
      } else {
        form.append(prefix, String(value))
      }
    }
    for (const [k, v] of Object.entries(body)) append(k, v)

    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getSecretKey()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    const json = await res.json() as Record<string, unknown>
    if (!res.ok) {
      const err = (json.error as { message?: string })?.message ?? `HTTP ${res.status}`
      return { ok: false, error: err }
    }
    return { ok: true, data: json }
  }

  /** Cria Stripe Checkout Session pra assinatura de um plano. */
  async createCheckoutForRequest(requestId: string): Promise<{ checkout_url: string; session_id: string }> {
    // 1. Busca o access_request
    const { data: req, error: reqErr } = await supabaseAdmin
      .from('access_requests')
      .select('id, email, name, requested_plan_key, status')
      .eq('id', requestId)
      .maybeSingle()
    if (reqErr || !req) throw new NotFoundException('Pedido de acesso não encontrado.')
    if (req.status === 'provisioned') throw new BadRequestException('Pedido já provisionado.')
    if (req.status === 'paid')        throw new BadRequestException('Pedido já pago — aguardando provisão automática.')
    if (req.status === 'rejected' || req.status === 'cancelled')
      throw new BadRequestException(`Pedido com status "${req.status}" — não pode pagar.`)
    if (!req.requested_plan_key) throw new BadRequestException('Pedido sem plano definido.')

    // 2. Busca o plan
    const { data: plan } = await supabaseAdmin
      .from('access_plans')
      .select('key, name, stripe_price_id, price_brl')
      .eq('key', req.requested_plan_key)
      .maybeSingle()
    if (!plan) throw new NotFoundException('Plano não encontrado.')
    if (!plan.stripe_price_id) {
      throw new BadRequestException(`Plano "${plan.key}" sem Stripe Price ID configurado. Rode o bootstrap.`)
    }

    // 3. Cria Checkout Session
    const result = await this.stripePost('/checkout/sessions', {
      mode: 'subscription',
      success_url: 'https://eclick.app.br/solicitar-acesso/sucesso?session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  'https://eclick.app.br/solicitar-acesso?cancelled=1',
      customer_email: req.email,
      'line_items[0][price]': plan.stripe_price_id,
      'line_items[0][quantity]': '1',
      'metadata[access_request_id]': req.id,
      'metadata[plan_key]':          plan.key,
      'subscription_data[metadata][access_request_id]': req.id,
      'subscription_data[metadata][plan_key]':          plan.key,
      allow_promotion_codes: 'true',
      billing_address_collection: 'required',
      locale: 'pt-BR',
    })
    if (result.ok === false) throw new BadRequestException(`Stripe checkout: ${result.error}`)
    const data = result.data
    const sessionId = data.id as string
    const checkoutUrl = data.url as string

    // 4. Marca o request com session_id (pra debug + retry)
    await supabaseAdmin
      .from('access_requests')
      .update({
        payment_provider:    'stripe',
        external_session_id: sessionId,
      })
      .eq('id', requestId)

    this.logger.log(`[stripe.checkout] criada session=${sessionId} request=${requestId} plan=${plan.key}`)
    return { checkout_url: checkoutUrl, session_id: sessionId }
  }

  /** Verifica HMAC do Stripe Webhook. Header formato: t=TIMESTAMP,v1=SIG */
  verifyWebhookSignature(rawBody: string, sigHeader: string | undefined, tolerance = 300): boolean {
    if (!sigHeader) return false
    const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
      const [k, v] = p.split('=')
      acc[k] = v
      return acc
    }, {})
    const ts = parts.t
    const sig = parts.v1
    if (!ts || !sig) return false

    // Tolerância: rejeita timestamp fora da janela
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - parseInt(ts, 10))
    if (ageSec > tolerance) {
      this.logger.warn(`[stripe.webhook] timestamp fora da janela: ${ageSec}s`)
      return false
    }

    const expected = crypto
      .createHmac('sha256', this.getWebhookSecret())
      .update(`${ts}.${rawBody}`, 'utf8')
      .digest('hex')

    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))
    } catch {
      return false
    }
  }

  /** Trata um evento Stripe. Validação de assinatura DEVE ter sido feita
   *  ANTES de chamar este método. */
  async handleEvent(event: { type: string; data: { object: Record<string, unknown> } }): Promise<{ handled: boolean; note?: string }> {
    const obj = event.data?.object ?? {}
    const meta = (obj.metadata as Record<string, string>) ?? {}

    switch (event.type) {
      case 'checkout.session.completed': {
        const requestId = meta.access_request_id
        const sessionId = obj.id as string
        const paymentStatus = obj.payment_status as string | undefined
        if (!requestId) {
          this.logger.warn(`[stripe.webhook] checkout.session.completed sem access_request_id metadata`)
          return { handled: false, note: 'missing_metadata' }
        }
        if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
          this.logger.log(`[stripe.webhook] session=${sessionId} payment_status=${paymentStatus} — ainda não pago`)
          // Marca pending pagamento
          await supabaseAdmin
            .from('access_requests')
            .update({ payment_provider: 'stripe', external_session_id: sessionId })
            .eq('id', requestId)
          return { handled: true, note: 'payment_pending' }
        }

        // Marca como pago e dispara provisionamento
        await supabaseAdmin
          .from('access_requests')
          .update({
            status:              'paid',
            paid_at:             new Date().toISOString(),
            payment_provider:    'stripe',
            external_session_id: sessionId,
            external_payment_id: (obj.subscription as string) ?? (obj.payment_intent as string) ?? null,
          })
          .eq('id', requestId)

        // Provisiona via approve (idempotente — cria user+org+sub+envia magic link)
        // Usa o próprio user platform-admin como reviewer (placeholder); no
        // futuro podemos detectar "reviewer = stripe-webhook" como source.
        const platformAdmin = await this.findPlatformAdminId()
        try {
          await this.access.approve(requestId, platformAdmin)
          this.logger.log(`[stripe.webhook] PROVISIONED request=${requestId} via session=${sessionId}`)
        } catch (e) {
          this.logger.error(`[stripe.webhook] falha ao provisionar request=${requestId}: ${(e as Error).message}`)
        }
        return { handled: true }
      }

      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const reqId = meta.access_request_id
        const subId = obj.id as string
        const status = obj.status as string
        if (!reqId) return { handled: false, note: 'missing_metadata' }

        // Procura a subscription correspondente na nossa tabela pelo external_id
        const { data: sub } = await supabaseAdmin
          .from('subscriptions')
          .select('id, organization_id, status')
          .eq('external_subscription_id', subId)
          .maybeSingle()
        if (sub) {
          let newStatus: string | null = null
          if (status === 'active' || status === 'trialing')     newStatus = 'active'
          else if (status === 'past_due' || status === 'unpaid') newStatus = 'past_due'
          else if (status === 'canceled' || status === 'incomplete_expired') newStatus = 'cancelled'
          if (newStatus) {
            await supabaseAdmin
              .from('subscriptions')
              .update({ status: newStatus, cancelled_at: newStatus === 'cancelled' ? new Date().toISOString() : null })
              .eq('id', sub.id)
            this.logger.log(`[stripe.webhook] sub=${sub.id} status -> ${newStatus} (stripe=${status})`)
          }
        }
        return { handled: true }
      }

      case 'invoice.payment_failed': {
        const subId = obj.subscription as string | undefined
        if (subId) {
          await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'past_due' })
            .eq('external_subscription_id', subId)
        }
        return { handled: true }
      }

      case 'invoice.payment_succeeded': {
        const subId = obj.subscription as string | undefined
        if (subId) {
          await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'active' })
            .eq('external_subscription_id', subId)
        }
        return { handled: true }
      }

      default:
        // Tolerante: aceita evento desconhecido e responde 200 (Stripe
        // espera 200 senão re-tenta indefinidamente)
        return { handled: true, note: `ignored:${event.type}` }
    }
  }

  /** Helper: pega user.id do platform admin pra atribuir como reviewer
   *  em aprovações automáticas via webhook. Fallback: o primeiro user
   *  com email vazzocomercio@gmail.com. */
  private async findPlatformAdminId(): Promise<string> {
    for (let page = 1; page <= 5; page++) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 })
      if (error) break
      const users = (data?.users ?? []) as Array<{ id: string; email?: string }>
      const found = users.find(u => (u.email ?? '').toLowerCase() === 'vazzocomercio@gmail.com')
      if (found) return found.id
      if (users.length < 200) break
    }
    // Fallback: id hardcoded da Vazzo (memória)
    return '60ad329d-c294-4ad7-b13b-7aaf4f5f76b6'
  }
}
