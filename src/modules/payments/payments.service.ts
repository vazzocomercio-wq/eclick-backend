import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { MercadoPagoService } from './mercado-pago.service'
import { StripeService } from './stripe.service'
import { CashbackService } from '../cashback/cashback.service'
import { BonusService } from '../bonus/bonus.service'
import { LoyaltyService } from '../loyalty/loyalty.service'
import { StorefrontNotificationsService } from '../storefront-notifications/storefront-notifications.service'
import { AffiliateAttributionService } from '../affiliates/affiliate-attribution.service'
import { CartRecoveryService } from '../cart-recovery/cart-recovery.service'
import { FulfillmentService } from '../fulfillment/fulfillment.service'
import { CouponsService } from '../coupons/coupons.service'
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
    private readonly mp:            MercadoPagoService,
    private readonly stripe:        StripeService,
    private readonly cashback:      CashbackService,
    private readonly bonus:         BonusService,
    private readonly loyalty:       LoyaltyService,
    private readonly notifications: StorefrontNotificationsService,
    private readonly affiliate:     AffiliateAttributionService,
    private readonly cartRecovery:  CartRecoveryService,
    private readonly fulfillment:   FulfillmentService,
    private readonly coupons:       CouponsService,
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
        // Delayed earn — não credita agora. CashbackCron.delayedEarnsDaily
        // varre pedidos paid antigos e credita quando a janela passa.
        this.logger.log(`[cashback] order=${orderId} earnDelay=${settings.earnDelay} — credit adiado`)
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

    // ── Loyalty: registra compra + recalcula tier ────────────────────
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, total, customer, status')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return
      const customer = (order.customer as { email?: string } | null) ?? {}
      const email    = (customer.email ?? '').trim().toLowerCase()
      if (!email) return
      const loyaltySettings = await this.loyalty.getSettings(order.organization_id as string)
      if (!loyaltySettings.enabled) return
      const totalCents = Math.round(Number(order.total ?? 0) * 100)
      if (totalCents <= 0) return
      const result = await this.loyalty.recordPurchase({
        orgId:       order.organization_id as string,
        email,
        amountCents: totalCents,
        orderId,
      })
      // Se subiu de tier, dispara notificação WhatsApp (idempotente via dedup_key)
      if (result.promotionId) {
        void this.notifications.notifyTierPromotion(result.promotionId)
      }
    } catch (err) {
      this.logger.error(`[loyalty] falhou pra order=${orderId}: ${(err as Error).message}`)
    }

    // ── WhatsApp: notifica cliente do pagamento confirmado ────────────
    void this.notifications.notifyOrderPaid(orderId)

    // ── Cart Recovery: marca cart como recovered (não bloqueia) ───────
    void this.cartRecovery.markRecoveredByOrder(orderId)

    // ── Afiliados: atribui comissão (idempotente via UNIQUE) ──────────
    void this.affiliate.attributeOrder(orderId).catch(err =>
      this.logger.warn(`[affiliate.attr] order=${orderId}: ${(err as Error).message}`)
    )

    // ── Cashback resgatado: debita o saldo ────────────────────────────
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, customer, status, cashback_used_cents')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return
      const used = Number((order as { cashback_used_cents?: number }).cashback_used_cents ?? 0)
      if (used <= 0) return
      const customer = (order.customer as { email?: string } | null) ?? {}
      const email    = (customer.email ?? '').trim().toLowerCase()
      if (!email) return
      await this.cashback.redeem({
        orgId:       order.organization_id as string,
        email,
        amountCents: used,
        reason:      `Resgate no pedido ${orderId.slice(0, 8)}`,
        sourceKind:  'storefront_order_redeem',
        sourceId:    orderId,
      })
    } catch (err) {
      // Já debitado (idempotência) ou saldo zerou no meio — apenas log
      this.logger.warn(`[cashback.redeem] order=${orderId} skipped: ${(err as Error).message}`)
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
        kitId:     it.kitId,
      })
    }

    // ── Desconto de kit ("Monte o ambiente") — server-authoritative ────
    // Aplica ANTES de bônus/cashback. Reescala o preço das linhas do kit pro
    // kit_price oficial (linhas positivas → vale MP e Stripe). Nunca confia
    // no preço do cliente.
    await this.applyKitDiscounts(orgId, out)

    // ── Bônus & Brindes — adiciona linhas com price=0 ──────────────────
    // Avalia regras ativas. Pra BOGO, reduz qty da linha paga em vez de
    // criar linha brinde (cliente vê "Leve 2 pague 1" como desconto puro
    // no item). Pra free_above_value/gift_with_product, adiciona linha
    // separada com price=0 do produto presente.
    try {
      const applied = await this.bonus.evaluateCart(orgId, out.map(i => ({
        productId: i.productId, qty: i.qty, price: i.price,
      })))
      if (applied.length > 0) {
        // Coleta gift_product_ids que ainda não estão no carrinho (precisamos
        // dos dados pra criar a linha)
        const giftIds = [...new Set(applied.map(a => a.giftProductId).filter(id => !out.some(o => o.productId === id)))]
        let giftData: Map<string, { name: string; photo: string | null }> = new Map()
        if (giftIds.length > 0) {
          const { data: gifts } = await supabaseAdmin
            .from('products')
            .select('id, name, photo_urls, storefront_visible')
            .in('id', giftIds)
            .eq('organization_id', orgId)
          for (const g of gifts ?? []) {
            if (!g.storefront_visible) continue
            giftData.set(g.id as string, {
              name:  String(g.name ?? ''),
              photo: Array.isArray(g.photo_urls) && g.photo_urls[0] ? String(g.photo_urls[0]) : null,
            })
          }
        }

        for (const bonus of applied) {
          if (bonus.type === 'bogo') {
            // BOGO: o brinde é o próprio trigger product. Em vez de criar
            // linha duplicada, baixamos o price médio da linha existente
            // (mantém qty intacto, cliente vê total reduzido).
            // Implementação simples: adiciona linha extra com price=0 +
            // qty=giftQty. Total fica certo (qtde paga × price + qtde grátis × 0).
            const triggerLine = out.find(o => o.productId === bonus.giftProductId)
            if (triggerLine) {
              // Diminui qty pago + cria linha brinde
              triggerLine.qty -= bonus.giftQty
              if (triggerLine.qty < 0) triggerLine.qty = 0
              out.push({
                productId: bonus.giftProductId,
                name:      `🎁 ${triggerLine.name} (${bonus.ruleName})`,
                price:     0,
                qty:       bonus.giftQty,
                imageUrl:  triggerLine.imageUrl,
              })
            }
          } else {
            const gift = giftData.get(bonus.giftProductId) ?? out.find(o => o.productId === bonus.giftProductId)
            if (!gift) continue
            out.push({
              productId: bonus.giftProductId,
              name:      `🎁 ${gift.name} (brinde — ${bonus.ruleName})`,
              price:     0,
              qty:       bonus.giftQty,
              imageUrl:  (gift as { photo?: string | null }).photo ?? (gift as { imageUrl?: string }).imageUrl,
            })
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[bonus] avaliação falhou — checkout sem brindes: ${(err as Error).message}`)
    }

    return out
  }

  /** Aplica o desconto dos kits ("Monte o ambiente") server-side. Pra cada
   *  kit reivindicado (via kitId nas linhas), busca o kit ATIVO, valida que
   *  todos os itens dele estão no carrinho na qtd certa, e reescala o preço
   *  daquelas linhas pra somar exatamente o kit_price oficial. Mutação
   *  in-place. Falha de validação = sem desconto (cobra cheio = seguro). */
  private async applyKitDiscounts(orgId: string, lines: CheckoutItem[]): Promise<void> {
    const kitIds = [...new Set(lines.map(l => l.kitId).filter((k): k is string => !!k))]
    if (kitIds.length === 0) return

    const { data: kits } = await supabaseAdmin
      .from('product_kits')
      .select('id, kit_price, items')
      .eq('organization_id', orgId)
      .eq('status', 'active')
      .in('id', kitIds)

    for (const kit of (kits ?? []) as Array<{ id: string; kit_price: number | null; items: Array<{ product_id: string; quantity: number }> }>) {
      const kitPrice = Number(kit.kit_price ?? 0)
      if (!(kitPrice > 0)) continue
      const kitLines = lines.filter(l => l.kitId === kit.id && l.price > 0)
      if (kitLines.length === 0) continue

      // Valida: todo item do kit presente com qtd >= a do kit (senão, sem desconto)
      const allPresent = (kit.items ?? []).every(ki => {
        const ln = kitLines.find(l => l.productId === ki.product_id)
        return ln && ln.qty >= (ki.quantity ?? 1)
      })
      if (!allPresent) continue

      const currentSum = kitLines.reduce((s, l) => s + l.price * l.qty, 0)
      if (!(currentSum > kitPrice)) continue   // já <= preço do kit (ex: promo melhor) → não encarece

      const factor = kitPrice / currentSum
      for (const l of kitLines) {
        l.price = Math.round(l.price * factor * 100) / 100
      }
      this.logger.log(`[kits] desconto aplicado kit=${kit.id}: R$${currentSum.toFixed(2)} -> R$${kitPrice.toFixed(2)}`)
    }
  }

  /** Snapshot inicial do pedido em storefront_orders (status=pending). */
  private async insertOrder(args: {
    orgId: string
    slug: string
    customer: CheckoutCustomer
    items: CheckoutItem[]
    gateway: Gateway | null
    cashbackUsedCents?: number
    customerId?: string
    affiliateId?: string
    couponCode?: string | null
    couponDiscountCents?: number
  }): Promise<StorefrontOrder> {
    // subtotal = só linhas POSITIVAS (a linha negativa de cashback é injetada
    // em `items` antes daqui pro gateway). Somar tudo aqui descontaria o
    // cashback no subtotal e o `- cashbackUsedReais` abaixo descontaria de
    // novo (bug de dupla subtração → total e earn de cashback subestimados).
    const subtotal = args.items.reduce((s, i) => s + Math.max(0, i.price) * i.qty, 0)
    const cashbackUsedReais = (args.cashbackUsedCents ?? 0) / 100
    const total = Math.max(0, subtotal - cashbackUsedReais) // sem frete configurado nesta fase
    const { data, error } = await supabaseAdmin
      .from('storefront_orders')
      .insert({
        organization_id:      args.orgId,
        store_slug:           args.slug,
        customer:             args.customer,
        items:                args.items,
        subtotal,
        total,
        gateway:               args.gateway,
        status:                'pending',
        cashback_used_cents:   args.cashbackUsedCents ?? 0,
        customer_id:           args.customerId ?? null,
        affiliate_id:          args.affiliateId ?? null,
        coupon_code:           args.couponCode ?? null,
        coupon_discount_cents: args.couponDiscountCents ?? 0,
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
    slug:           string
    items:          CheckoutItem[]
    customer:       CheckoutCustomer
    gateway:        Gateway
    cashbackToUse?: number  // centavos — opt-in pelo cliente
    customerId?:    string  // FK opcional pra storefront_customers (cliente logado)
    affiliateCode?: string  // code do afiliado (cookie ?ref=)
    couponCode?:    string  // cupom aplicado (validado server-side aqui)
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

    // ── Cupom (opt-in) — validado + aplicado SERVER-SIDE ─────────────
    // O front só sugere; aqui revalidamos (ativo/validade/limite/mínimo) e
    // descontamos escalando as linhas (vale MP e Stripe — linhas positivas).
    // O used_count só incrementa no runPaidHooks (1ª transição p/ 'paid'),
    // respeitando usage_limit só em pedido efetivamente pago.
    let couponCode: string | null = null
    let couponDiscountCents = 0
    if (input.couponCode?.trim()) {
      const subC = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100)
      const applied = await this.coupons.apply(store.orgId, input.couponCode, subC) // lança se inválido
      couponCode = applied.code
      if (applied.discount_cents > 0 && subC > 0) {
        const factor = Math.max(0, subC - applied.discount_cents) / subC
        for (const it of items) it.price = Math.round(it.price * factor * 100) / 100
        couponDiscountCents = applied.discount_cents
      }
    }

    // ── Resgate de cashback (opt-in) ─────────────────────────────────
    // Server-side: valida saldo + regras (minBalance, maxRedemptionPct).
    // Em vez de mexer nos items individuais (gateways tratam diferente),
    // injeta linha negativa "💰 Cashback aplicado" pro MP. Stripe não
    // aceita unit_amount negativo — bloqueia cashback com Stripe por ora.
    let cashbackUsedCents = 0
    if (input.cashbackToUse && input.cashbackToUse > 0) {
      if (input.gateway === 'stripe') {
        throw new BadRequestException('Resgate de cashback com Stripe ainda não está disponível. Use Mercado Pago ou desative o cashback no checkout.')
      }
      const subtotalCents = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100)
      const preview = await this.cashback.previewRedemption(
        store.orgId,
        input.customer.email,
        subtotalCents,
      )
      if (!preview.enabled) {
        throw new BadRequestException('Cashback não está ativo nesta loja.')
      }
      if (input.cashbackToUse > preview.maxRedeemableCents) {
        throw new BadRequestException(
          `Saldo insuficiente ou acima do limite. Máximo permitido: R$ ${(preview.maxRedeemableCents / 100).toFixed(2)}`,
        )
      }
      cashbackUsedCents = input.cashbackToUse

      // Adiciona linha negativa pro gateway entender o desconto
      items.push({
        productId: 'CASHBACK_DISCOUNT',
        name:      `💰 Cashback aplicado`,
        price:     -(cashbackUsedCents / 100),
        qty:       1,
      })
    }

    // Resolve affiliateCode → affiliateId (afiliado deve estar approved)
    let affiliateId: string | undefined
    if (input.affiliateCode) {
      const code = input.affiliateCode.trim().toLowerCase()
      if (code) {
        const { data: aff } = await supabaseAdmin
          .from('affiliates').select('id, status')
          .eq('organization_id', store.orgId).eq('code', code).maybeSingle()
        if (aff && (aff as { status: string }).status === 'approved') {
          affiliateId = (aff as { id: string }).id
        }
        // Silent skip se code inválido — não bloqueia checkout
      }
    }

    const order = await this.insertOrder({
      orgId:             store.orgId,
      slug:              input.slug,
      customer:          input.customer,
      items,
      gateway:           input.gateway,
      cashbackUsedCents,
      customerId:        input.customerId,
      affiliateId,
      couponCode,
      couponDiscountCents,
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
    const upd = { gateway_payment_id: paymentId, raw_callback: payment.raw }
    if (status === 'paid') {
      // Gate de transição: hooks de pago rodam SÓ na 1ª vez. MP reentrega o
      // webhook N vezes — sem isso, fidelidade/stats de kit dobravam.
      const { data: transitioned } = await supabaseAdmin
        .from('storefront_orders')
        .update({ status, ...upd })
        .eq('id', orderId)
        .neq('status', 'paid')
        .select('id')
      const first = (transitioned?.length ?? 0) > 0
      this.logger.log(`[mp.webhook] order=${orderId} payment=${paymentId} -> paid (1a transicao=${first})`)
      if (first) {
        await this.verifyPaidAmount(orderId, 'mercadopago', payment.transactionAmount)
        await this.runPaidHooks(orderId)
      }
    } else {
      await supabaseAdmin.from('storefront_orders').update({ status, ...upd }).eq('id', orderId)
      this.logger.log(`[mp.webhook] order=${orderId} payment=${paymentId} -> ${status}`)
    }
  }

  /** C4 — confere o valor efetivamente pago vs `storefront_orders.total`.
   *  Os valores são fixados server-side na criação da preferência (MP) /
   *  sessão (Stripe) — o cliente não consegue alterar — então isto é
   *  DETECÇÃO de drift/subpagamento, NÃO bloqueio: loga discrepância material
   *  mas não derruba o webhook (um falso-positivo aqui = pedido pago que nunca
   *  vira 'paid' = outage). O raw_callback guarda o payload pra auditoria. */
  private async verifyPaidAmount(orderId: string, gateway: Gateway, paidReais: number | null): Promise<void> {
    try {
      if (paidReais == null || !Number.isFinite(paidReais)) {
        this.logger.warn(`[pay.verify] order=${orderId} gateway=${gateway} sem valor no payload — verificação pulada`)
        return
      }
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('total')
        .eq('id', orderId)
        .maybeSingle()
      if (!order) return
      const total = Number((order as { total: number }).total ?? 0)
      const diff  = paidReais - total
      const tol   = Math.max(0.02, total * 0.01) // 1% ou R$0,02
      if (diff < -tol) {
        this.logger.error(`[pay.verify] SUBPAGAMENTO order=${orderId} gateway=${gateway} pago=R$${paidReais.toFixed(2)} total=R$${total.toFixed(2)} diff=R$${diff.toFixed(2)} — revisar manualmente`)
      } else if (diff > tol) {
        this.logger.warn(`[pay.verify] order=${orderId} gateway=${gateway} pago MAIOR que total (frete/ajuste?) pago=R$${paidReais.toFixed(2)} total=R$${total.toFixed(2)}`)
      }
    } catch (e) {
      this.logger.warn(`[pay.verify] order=${orderId} falhou: ${(e as Error).message}`)
    }
  }

  /** Hooks que rodam UMA vez quando o pedido vira 'paid'. Chamado só na
   *  transição (gate via UPDATE condicional) pra ser idempotente em reentrega. */
  private async runPaidHooks(orderId: string): Promise<void> {
    await this.creditCashbackOnPaid(orderId)
    await this.renewVisualizerCreditsOnPaid(orderId)
    await this.bumpKitStatsOnPaid(orderId)
    await this.incrementCouponOnPaid(orderId)
    void this.fulfillment.autoIngestStorefrontOrder(orderId)
  }

  /** Contabiliza o uso do cupom (used_count) quando o pedido vira pago.
   *  Idempotente: runPaidHooks só roda na 1ª transição (gate). */
  private async incrementCouponOnPaid(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, coupon_code, status')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return
      const code = ((order.coupon_code as string | null) ?? '').trim()
      if (!code) return
      await this.coupons.incrementUsage(order.organization_id as string, code)
    } catch (e) {
      this.logger.warn(`[coupon] incrementUsage falhou order=${orderId}: ${(e as Error).message}`)
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
    let paidReais: number | null = null

    if (event.type === 'checkout.session.completed') {
      const ps = obj.payment_status as string | undefined
      status   = ps === 'paid' ? 'paid' : ps === 'unpaid' ? 'awaiting_payment' : 'pending'
      paymentId = (obj.payment_intent as string | null) ?? null
      if (typeof obj.amount_total === 'number') paidReais = obj.amount_total / 100
    } else if (event.type === 'payment_intent.succeeded') {
      status   = 'paid'
      paymentId = (obj.id as string | null) ?? null
      const cents = (obj.amount_received ?? obj.amount) as number | undefined
      if (typeof cents === 'number') paidReais = cents / 100
    } else if (event.type === 'payment_intent.payment_failed') {
      status = 'failed'
    } else if (event.type === 'charge.refunded') {
      status = 'refunded'
    }

    if (!status) {
      this.logger.log(`[stripe.webhook] evento ${event.type} ignorado`)
      return
    }

    const upd = { gateway_payment_id: paymentId ?? undefined, raw_callback: event }
    if (status === 'paid') {
      // Gate de transição: hooks de pago rodam SÓ na 1ª vez (idempotente em
      // reentrega de webhook — sem isso fidelidade/stats dobravam).
      const { data: transitioned } = await supabaseAdmin
        .from('storefront_orders')
        .update({ status, ...upd })
        .eq('id', orderId)
        .eq('organization_id', orgId)
        .neq('status', 'paid')
        .select('id')
      const first = (transitioned?.length ?? 0) > 0
      this.logger.log(`[stripe.webhook] order=${orderId} event=${event.type} -> paid (1a transicao=${first})`)
      if (first) {
        await this.verifyPaidAmount(orderId, 'stripe', paidReais)
        await this.runPaidHooks(orderId)
      }
    } else {
      await supabaseAdmin
        .from('storefront_orders')
        .update({ status, ...upd })
        .eq('id', orderId)
        .eq('organization_id', orgId)
      this.logger.log(`[stripe.webhook] order=${orderId} event=${event.type} -> ${status}`)
    }
  }

  /** Métrica do "Monte o ambiente" — quando o pedido vira 'paid', soma +1
   *  venda e a receita do kit (preço já com desconto) em product_kits. Soft
   *  metric, best-effort (nunca quebra o checkout). Pode super-contar de leve
   *  em retry de webhook — aceitável pra um indicador. */
  private async bumpKitStatsOnPaid(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, items, status')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return

      const items = (order.items as CheckoutItem[]) ?? []
      const revByKit = new Map<string, number>()
      for (const it of items) {
        if (!it.kitId) continue
        revByKit.set(it.kitId, (revByKit.get(it.kitId) ?? 0) + Number(it.price) * Number(it.qty))
      }
      if (revByKit.size === 0) return

      const orgId = order.organization_id as string
      for (const [kitId, rev] of revByKit.entries()) {
        const { data: kit } = await supabaseAdmin
          .from('product_kits')
          .select('sales, revenue')
          .eq('id', kitId).eq('organization_id', orgId)
          .maybeSingle()
        if (!kit) continue
        await supabaseAdmin
          .from('product_kits')
          .update({
            sales:   Number((kit as { sales?: number }).sales ?? 0) + 1,
            revenue: Math.round((Number((kit as { revenue?: number }).revenue ?? 0) + rev) * 100) / 100,
          })
          .eq('id', kitId).eq('organization_id', orgId)
      }
    } catch (err) {
      this.logger.warn(`[kits] bumpKitStatsOnPaid falhou: ${(err as Error).message}`)
    }
  }

  /** Hook do Ambientador IA — quando o pedido vira 'paid', renova os
   *  créditos de geração do cliente (reseta generations_used → ele recupera
   *  a cota cheia). Casa o cliente por telefone (senão e-mail) na org.
   *  Best-effort — erro não derruba o webhook. */
  private async renewVisualizerCreditsOnPaid(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('organization_id, customer, status')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return
      const c = (order.customer as { phone?: string; email?: string } | null) ?? {}
      const phone = (c.phone ?? '').replace(/\D/g, '')
      const email = (c.email ?? '').trim().toLowerCase()
      if (!phone && !email) return
      const orgId = order.organization_id as string

      let q = supabaseAdmin
        .from('storefront_visualizer_customers')
        .select('id')
        .eq('organization_id', orgId)
      q = phone ? q.eq('phone', phone) : q.eq('email', email)
      const { data: vc } = await q.limit(1).maybeSingle()
      if (!vc) return

      await supabaseAdmin
        .from('storefront_visualizer_customers')
        .update({ generations_used: 0, last_renewed_at: new Date().toISOString() })
        .eq('id', (vc as { id: string }).id)
      this.logger.log(`[visualizer] créditos renovados após compra paga (order=${orderId})`)
    } catch (e) {
      this.logger.warn(`[visualizer] renew créditos falhou order=${orderId}: ${(e as Error).message}`)
    }
  }

  /** Atualiza status de entrega de um pedido (admin).
   *  Quando vai pra 'shipped', preenche shipped_at (se não veio).
   *  Quando vai pra 'delivered', preenche delivered_at. */
  async updateShipping(
    orgId: string,
    orderId: string,
    patch: {
      shipping_status?:  'pending' | 'preparing' | 'shipped' | 'in_transit' | 'delivered' | 'returned' | 'lost'
      shipping_carrier?: string | null
      tracking_code?:    string | null
    },
  ): Promise<{ ok: true }> {
    const fields: Record<string, unknown> = {}
    if ('shipping_status'  in patch) fields.shipping_status  = patch.shipping_status
    if ('shipping_carrier' in patch) fields.shipping_carrier = patch.shipping_carrier ?? null
    if ('tracking_code'    in patch) fields.tracking_code    = patch.tracking_code ?? null

    // Auto-stamp timestamps quando transiciona
    if (patch.shipping_status === 'shipped' || patch.shipping_status === 'in_transit') {
      const { data: cur } = await supabaseAdmin
        .from('storefront_orders').select('shipped_at').eq('id', orderId).eq('organization_id', orgId).maybeSingle()
      if (cur && !(cur as { shipped_at?: string | null }).shipped_at) {
        fields.shipped_at = new Date().toISOString()
      }
    }
    if (patch.shipping_status === 'delivered') {
      const { data: cur } = await supabaseAdmin
        .from('storefront_orders').select('delivered_at').eq('id', orderId).eq('organization_id', orgId).maybeSingle()
      if (cur && !(cur as { delivered_at?: string | null }).delivered_at) {
        fields.delivered_at = new Date().toISOString()
      }
    }

    if (Object.keys(fields).length === 0) {
      throw new BadRequestException('Nenhum campo de tracking informado')
    }

    const { error } = await supabaseAdmin
      .from('storefront_orders')
      .update(fields)
      .eq('id', orderId)
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    // Quando muda pra 'delivered', dispara hook de cashback after_delivery
    if (patch.shipping_status === 'delivered') {
      await this.creditCashbackAfterDelivery(orderId).catch(err =>
        this.logger.warn(`[cashback.after_delivery] order=${orderId}: ${(err as Error).message}`)
      )
    }

    // ── WhatsApp: notifica cliente das transições importantes ─────────
    if (patch.shipping_status === 'shipped' || patch.shipping_status === 'in_transit') {
      void this.notifications.notifyOrderShipped(orderId)
    }
    if (patch.shipping_status === 'delivered') {
      void this.notifications.notifyOrderDelivered(orderId)
    }

    return { ok: true }
  }

  /** Quando pedido vira 'delivered' e a org tem earnDelay='after_delivery',
   *  credita o cashback agora (idempotente via source_id). */
  private async creditCashbackAfterDelivery(orderId: string): Promise<void> {
    const { data: order } = await supabaseAdmin
      .from('storefront_orders')
      .select('organization_id, total, customer, status, shipping_status')
      .eq('id', orderId)
      .maybeSingle()
    if (!order || (order.status as string) !== 'paid') return
    if ((order.shipping_status as string) !== 'delivered') return

    const customer = (order.customer as { email?: string } | null) ?? {}
    const email = (customer.email ?? '').trim().toLowerCase()
    if (!email) return

    const settings = await this.cashback.getSettings(order.organization_id as string)
    if (!settings.enabled || settings.earnPct <= 0) return
    if (settings.earnDelay !== 'after_delivery') return

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
      reason:      `Pedido ${orderId.slice(0, 8)} entregue — ${settings.earnPct}% cashback`,
      sourceKind:  'storefront_order',
      sourceId:    orderId,
      expiresAt,
    })
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
