import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadoPagoService } from './mercado-pago.service'
import { StripeService } from './stripe.service'
import { CashbackService } from '../cashback/cashback.service'
import type {
  CheckoutCustomer, CheckoutItem, Gateway, StorefrontOrder,
} from './types'

/**
 * Loja Propria — Frente C: orquestracao do checkout.
 *
 * Fluxo:
 *  1. Frontend POST /storefront/checkout com items + customer + gateway
 *  2. Resolvemos a loja (org_id pelo slug)
 *  3. Recalculamos os precos no servidor a partir do catalogo (NUNCA
 *     confiar no preco que veio do client — anti-fraude basica)
 *  4. INSERT em storefront_orders (status=pending)
 *  5. Chama o gateway escolhido → recebe sessionId + initPoint
 *  6. UPDATE storefront_orders com session_id + init_point + status=awaiting_payment
 *  7. Devolve { orderId, initPoint } pro frontend redirecionar
 *
 * Webhook:
 *  1. MP/Stripe chama nosso endpoint com evento
 *  2. Validamos (signature pro Stripe, GET payment pra MP)
 *  3. UPDATE storefront_orders status conforme evento
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name)

  constructor(
    private readonly mp:       MercadoPagoService,
    private readonly stripe:   StripeService,
    private readonly cashback: CashbackService,
  ) {}

  /** Hook de cashback — chamado dos dois webhooks quando o pedido vira
   *  'paid'. Lê email do customer + total do pedido, busca settings da
   *  org, e credita earnPct * total. Idempotente via source_id = orderId.
   *  Erro aqui NÃO derruba o webhook (cashback é feature opcional). */
  private async creditCashbackOnPaid(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, total, customer, status')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return
      const customer = (order.customer as { email?: string } | null) ?? {}
      const email    = (customer.email ?? '').trim().toLowerCase()
      if (!email) {
        this.logger.log(`[cashback] order=${orderId} sem email — pulando`)
        return
      }
      const settings = await this.cashback.getSettings(order.organization_id as string)
      if (!settings.enabled || settings.earnPct <= 0) return
      if (settings.earnDelay !== 'immediate') {
        // TODO: agendar job pro after_delivery / after_7_days (cron) — MVP só immediate
        this.logger.log(`[cashback] earnDelay=${settings.earnDelay} ignorado por enquanto (MVP)`)
        return
      }

      const totalCents = Math.round(Number(order.total ?? 0) * 100)
      const amountCents = Math.round((totalCents * settings.earnPct) / 100)
      if (amountCents <= 0) return

      const expiresAt = settings.expirationDays > 0
        ? new Date(Date.now() + settings.expirationDays * 86400_000).toISOString()
        : null

      await this.cashback.credit({
        orgId:       order.organization_id as string,
        email,
        amountCents,
        reason:      `Pedido ${orderId.slice(0, 8)} — ${settings.earnPct}% cashback`,
        sourceKind:  'storefront_order',
        sourceId:    orderId,
        expiresAt,
      })
    } catch (err) {
      this.logger.error(`[cashback] falhou pra order=${orderId}: ${(err as Error).message}`)
    }
  }

  /** Resolve org_id + custom_domain a partir do slug publico. */
  private async resolveStore(slug: string): Promise<{ orgId: string; storeName: string; customDomain: string | null }> {
    const { data, error } = await supabaseAdmin
      .from('store_config')
      .select('organization_id, store_name, custom_domain')
      .eq('store_slug', slug)
      .eq('status', 'active')
      .maybeSingle()
    if (error) throw new BadRequestException(`Erro ao carregar a loja: ${error.message}`)
    if (!data)  throw new NotFoundException('Loja não encontrada.')
    return {
      orgId:        data.organization_id as string,
      storeName:    (data.store_name as string) ?? slug,
      customDomain: (data.custom_domain as string | null) ?? null,
    }
  }

  /** Lê os produtos do carrinho do catalogo, retorna lista revalidada
   *  (preco do servidor, name do servidor, photo_url[0] como imagem).
   *  Itens fora do catalogo (ou sem estoque) sao removidos. */
  private async revalidateItems(orgId: string, items: CheckoutItem[]): Promise<CheckoutItem[]> {
    const ids = [...new Set(items.map(i => i.productId))]
    if (ids.length === 0) return []
    const { data, error } = await supabaseAdmin
      .from('products')
      .select('id, name, price, sale_price, sale_start_at, sale_end_at, photo_urls, stock, storefront_visible')
      .in('id', ids)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao validar produtos: ${error.message}`)

    // Preço efetivo = sale_price se janela ativa, senão price. SEMPRE
    // calculado server-side — frontend não decide preço final, só sugere.
    const nowMs = Date.now()
    const byId = new Map<string, { id: string; name: string; price: number; photo: string | null; stock: number; visible: boolean }>()
    for (const r of data ?? []) {
      const basePrice = Number(r.price ?? 0)
      const sale      = r.sale_price as number | null
      const starts    = r.sale_start_at as string | null
      const ends      = r.sale_end_at as string | null
      let effective = basePrice
      if (sale != null && Number(sale) > 0 && Number(sale) < basePrice) {
        const okStart = !starts || nowMs >= Date.parse(starts)
        const okEnd   = !ends   || nowMs <= Date.parse(ends)
        if (okStart && okEnd) effective = Number(sale)
      }
      byId.set(r.id as string, {
        id:      r.id as string,
        name:    String(r.name ?? ''),
        price:   effective,
        photo:   Array.isArray(r.photo_urls) && r.photo_urls[0] ? String(r.photo_urls[0]) : null,
        stock:   Number(r.stock ?? 0),
        visible: Boolean(r.storefront_visible),
      })
    }

    const out: CheckoutItem[] = []
    for (const it of items) {
      const p = byId.get(it.productId)
      if (!p || !p.visible || p.price <= 0) continue
      const qty = Math.min(Math.max(1, Math.floor(it.qty)), Math.max(1, p.stock || 1))
      out.push({
        productId: p.id,
        name:      p.name,
        price:     p.price,
        qty,
        imageUrl:  p.photo ?? undefined,
      })
    }
    return out
  }

  /** Snapshot inicial do pedido em storefront_orders (status=pending). */
  private async insertOrder(args: {
    orgId: string
    slug: string
    customer: CheckoutCustomer
    items: CheckoutItem[]
    gateway: Gateway | null
  }): Promise<StorefrontOrder> {
    const subtotal = args.items.reduce((s, i) => s + i.price * i.qty, 0)
    const total = subtotal // sem frete configurado nesta fase
    const { data, error } = await supabaseAdmin
      .from('storefront_orders')
      .insert({
        organization_id: args.orgId,
        store_slug:      args.slug,
        customer:        args.customer,
        items:           args.items,
        subtotal,
        total,
        gateway:         args.gateway,
        status:          'pending',
      })
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar pedido: ${error?.message ?? '?'}`)
    return data as unknown as StorefrontOrder
  }

  /** Atualiza pedido com session do gateway + init_point. */
  private async attachGateway(orderId: string, sessionId: string, initPoint: string): Promise<void> {
    const { error } = await supabaseAdmin
      .from('storefront_orders')
      .update({
        gateway_session_id: sessionId,
        gateway_init_point: initPoint,
        status:             'awaiting_payment',
      })
      .eq('id', orderId)
    if (error) throw new BadRequestException(`Erro ao registrar sessão: ${error.message}`)
  }

  /** Constroi URLs de retorno do gateway baseado no custom_domain ou
   *  caindo pro app.eclick.app.br/loja/[slug]. */
  private buildReturnUrls(slug: string, customDomain: string | null, orderId: string): {
    success: string; failure: string; pending: string; webhook: string
  } {
    const publicBase = customDomain
      ? `https://${customDomain}`
      : `https://eclick.app.br/loja/${slug}`
    const apiBase   = process.env.PUBLIC_API_BASE_URL
                   ?? 'https://eclick-backend-production-2a87.up.railway.app'
    return {
      success: `${publicBase}/pedido/${orderId}/sucesso`,
      failure: `${publicBase}/pedido/${orderId}/falha`,
      pending: `${publicBase}/pedido/${orderId}/pendente`,
      webhook: `${apiBase}/storefront/webhooks/mp`,
    }
  }

  /** Endpoint public-facing — sem auth, chamado pela vitrine. */
  async checkout(input: {
    slug:     string
    items:    CheckoutItem[]
    customer: CheckoutCustomer
    gateway:  Gateway
  }): Promise<{ orderId: string; initPoint: string }> {
    if (!input.slug)               throw new BadRequestException('slug obrigatório')
    if (!Array.isArray(input.items) || input.items.length === 0)
                                   throw new BadRequestException('Carrinho vazio.')
    if (!input.customer?.name || !input.customer?.email)
                                   throw new BadRequestException('Nome e e-mail são obrigatórios.')
    if (input.gateway !== 'mercadopago' && input.gateway !== 'stripe')
                                   throw new BadRequestException('Gateway inválido.')

    const store = await this.resolveStore(input.slug)
    const items = await this.revalidateItems(store.orgId, input.items)
    if (items.length === 0) throw new BadRequestException('Nenhum dos itens está disponível.')

    const order = await this.insertOrder({
      orgId:   store.orgId,
      slug:    input.slug,
      customer:input.customer,
      items,
      gateway: input.gateway,
    })

    const urls = this.buildReturnUrls(input.slug, store.customDomain, order.id)

    let result: { sessionId: string; initPoint: string }
    if (input.gateway === 'mercadopago') {
      result = await this.mp.createCheckout(store.orgId, order, {
        success: urls.success,
        failure: urls.failure,
        pending: urls.pending,
        webhook: urls.webhook,
      })
    } else {
      result = await this.stripe.createCheckout(store.orgId, order, {
        success: urls.success,
        cancel:  urls.failure,
      })
    }

    await this.attachGateway(order.id, result.sessionId, result.initPoint)
    this.logger.log(`[checkout] org=${store.orgId} slug=${input.slug} order=${order.id} gateway=${input.gateway} session=${result.sessionId}`)
    return { orderId: order.id, initPoint: result.initPoint }
  }

  // ─── Webhooks ────────────────────────────────────────────────────────

  /** Mercado Pago webhook. Payload exemplo: `?topic=payment&id=12345`. */
  async handleMercadoPagoWebhook(query: Record<string, string>): Promise<void> {
    const topic = query.topic ?? query.type
    if (topic !== 'payment') {
      this.logger.log(`[mp.webhook] topic ignorado: ${topic}`)
      return
    }
    const paymentId = query.id ?? query['data.id']
    if (!paymentId) { this.logger.warn('[mp.webhook] sem payment id'); return }

    // Precisamos da org_id pra resolver o token — descobrimos pelo
    // external_reference depois de buscar o payment. Mas pra buscar precisamos
    // do token. Catch-22 → fazemos lookup-by-session usando todos os tokens
    // configurados? Versao pragmatica: tentamos com token GLOBAL primeiro,
    // depois resolvemos org via external_reference, e refazemos lookup se
    // necessario.
    // No MVP: assumimos credencial GLOBAL (chave da Vazzo ou shared).
    let payment
    try {
      payment = await this.mp.fetchPayment('global-noop', paymentId)
    } catch {
      // tenta a primeira org com MP configurado
      const { data: orgs } = await supabaseAdmin
        .from('api_credentials')
        .select('organization_id').eq('provider', 'mercadopago').limit(5)
      let lastErr: Error | null = null
      for (const row of orgs ?? []) {
        try {
          payment = await this.mp.fetchPayment(row.organization_id as string, paymentId)
          break
        } catch (e) { lastErr = e as Error }
      }
      if (!payment) {
        this.logger.error(`[mp.webhook] payment ${paymentId} nao localizado: ${lastErr?.message}`)
        return
      }
    }

    const orderId = payment.externalReference
    if (!orderId) { this.logger.warn(`[mp.webhook] payment ${paymentId} sem external_reference`); return }

    const status = mapMpStatus(payment.status)
    await supabaseAdmin
      .from('storefront_orders')
      .update({
        status,
        gateway_payment_id: paymentId,
        raw_callback:       payment.raw,
      })
      .eq('id', orderId)

    this.logger.log(`[mp.webhook] order=${orderId} payment=${paymentId} -> ${status}`)

    if (status === 'paid') {
      await this.creditCashbackOnPaid(orderId)
    }
  }

  /** Stripe webhook — payload no body (raw), signature em header. */
  async handleStripeWebhook(rawBody: string, signature: string): Promise<void> {
    // Buscar org via metadata do evento (parse leve sem SDK).
    let event: { type: string; data: { object: Record<string, unknown> } }
    try { event = JSON.parse(rawBody) }
    catch { this.logger.warn('[stripe.webhook] payload invalido'); return }

    const obj = event.data?.object ?? {}
    const meta = (obj.metadata as Record<string, string>) ?? {}
    const orgId   = meta.organization_id
    const orderId = meta.storefront_order_id

    if (!orgId || !orderId) {
      this.logger.warn('[stripe.webhook] sem metadata.organization_id/storefront_order_id')
      return
    }

    const ok = await this.stripe.verifyWebhookSignature(orgId, rawBody, signature)
    if (!ok) {
      this.logger.warn(`[stripe.webhook] assinatura invalida pra order=${orderId}`)
      return
    }

    let status: StorefrontOrder['status'] | null = null
    let paymentId: string | null = null

    if (event.type === 'checkout.session.completed') {
      const ps = obj.payment_status as string | undefined
      status   = ps === 'paid' ? 'paid' : ps === 'unpaid' ? 'awaiting_payment' : 'pending'
      paymentId = (obj.payment_intent as string | null) ?? null
    } else if (event.type === 'payment_intent.succeeded') {
      status   = 'paid'
      paymentId = (obj.id as string | null) ?? null
    } else if (event.type === 'payment_intent.payment_failed') {
      status = 'failed'
    } else if (event.type === 'charge.refunded') {
      status = 'refunded'
    }

    if (!status) {
      this.logger.log(`[stripe.webhook] evento ${event.type} ignorado`)
      return
    }

    await supabaseAdmin
      .from('storefront_orders')
      .update({
        status,
        gateway_payment_id: paymentId ?? undefined,
        raw_callback:       event,
      })
      .eq('id', orderId)
      .eq('organization_id', orgId)

    this.logger.log(`[stripe.webhook] order=${orderId} event=${event.type} -> ${status}`)

    if (status === 'paid') {
      await this.creditCashbackOnPaid(orderId)
    }
  }

  /** Detalhe publico do pedido — usado pelas paginas /sucesso /falha /pendente. */
  async getPublicOrder(orderId: string): Promise<{
    id:        string
    status:    string
    total:     number
    items:     CheckoutItem[]
    customer:  { name: string; email: string }   // dados sensíveis nunca expostos aqui
    gateway:   Gateway | null
    initPoint: string | null
  } | null> {
    const { data } = await supabaseAdmin
      .from('storefront_orders')
      .select('id, status, total, items, customer, gateway, gateway_init_point')
      .eq('id', orderId)
      .maybeSingle()
    if (!data) return null
    const c = (data.customer as { name?: string; email?: string }) ?? {}
    return {
      id:        data.id as string,
      status:    data.status as string,
      total:     Number(data.total),
      items:     (data.items as CheckoutItem[]) ?? [],
      customer:  { name: c.name ?? '', email: c.email ?? '' },
      gateway:   (data.gateway as Gateway | null) ?? null,
      initPoint: (data.gateway_init_point as string | null) ?? null,
    }
  }
}

/** Mercado Pago payment.status -> storefront_orders.status. */
function mapMpStatus(s: string): StorefrontOrder['status'] {
  switch (s) {
    case 'approved':   return 'paid'
    case 'pending':
    case 'in_process': return 'awaiting_payment'
    case 'rejected':   return 'failed'
    case 'cancelled':  return 'cancelled'
    case 'refunded':   return 'refunded'
    case 'charged_back': return 'refunded'
    default:           return 'pending'
  }
}
