import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { createHash, randomBytes } from 'node:crypto'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { CouponsService } from '../coupons/coupons.service'

/**
 * AB1 — Recovery de carrinho abandonado.
 *
 * Fluxo:
 *   1. Frontend "pinga" /track sempre que o carrinho muda E o cliente
 *      tem identificação (logado, ou preencheu phone/email no checkout).
 *      Upsert em whatsapp_carts (1 row por org+phone OU org+email).
 *   2. Cron a cada 15 min:
 *      - Carrega config (cart_recovery_settings) por org com enabled=true
 *      - Busca whatsapp_carts active, sem reminder, com
 *        last_activity_at < now() - minutes_after
 *      - Pra cada: monta mensagem (template lojista ou default),
 *        dispara WhatsApp via ActiveBridge.sendDirectMessage
 *      - Marca reminder_sent_at + status='sent_reminder'
 *      - Também expira carts com TTL ultrapassado (status='expired')
 *   3. Hook em payments quando order=paid:
 *      cart-recovery.markRecovered(orderId) procura cart pelo customer
 *      do pedido (phone/email match) e marca recovered + linka order.
 *
 * Anti-spam:
 *   - IP hash gravado (SHA-256) — útil pra detectar bot que pinga sem
 *     parar; lojista pode bloquear via dashboard se necessário.
 *   - dedup_key no bridge garante 1 envio por cart por dia.
 */

export interface CartRecoverySettings {
  enabled:           boolean
  minutes_after:     number   // default 30
  ttl_hours:         number   // default 72
  message_template:  string   // pode usar {{name}} {{store}} {{items}} {{subtotal}} {{link}} {{coupon}}
  // AB2 — cupom de incentivo
  coupon_enabled:        boolean   // gera cupom único por lembrete
  coupon_discount_pct:   number    // % de desconto (1-90)
  coupon_expires_hours:  number    // validade do cupom em horas
}

const DEFAULT_SETTINGS: CartRecoverySettings = {
  enabled:              false,
  minutes_after:        30,
  ttl_hours:            72,
  message_template:     '',
  coupon_enabled:       false,
  coupon_discount_pct:  10,
  coupon_expires_hours: 48,
}

export interface CartItem {
  productId: string
  name:      string
  price:     number
  qty:       number
  imageUrl?: string
}

export interface WhatsappCart {
  id:                 string
  organization_id:    string
  store_slug:         string
  customer_id:        string | null
  customer_phone:     string | null
  customer_email:     string | null
  customer_name:      string | null
  items:              CartItem[]
  subtotal:           number
  items_count:        number
  status:             'active' | 'sent_reminder' | 'recovered' | 'expired' | 'dismissed'
  last_activity_at:   string
  reminder_sent_at:    string | null
  reminder_dedup_key:  string | null
  reminder_coupon_code: string | null
  recovered_order_id:  string | null
  recovered_at:        string | null
  created_at:          string
  updated_at:          string
}

@Injectable()
export class CartRecoveryService {
  private readonly logger = new Logger(CartRecoveryService.name)

  constructor(
    private readonly bridge:  ActiveBridgeClient,
    private readonly coupons: CouponsService,
  ) {}

  // ── Settings ──────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<CartRecoverySettings> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('cart_recovery_settings')
      .eq('organization_id', orgId)
      .maybeSingle()
    const raw = (data?.cart_recovery_settings ?? {}) as Partial<CartRecoverySettings>
    return { ...DEFAULT_SETTINGS, ...raw }
  }

  async updateSettings(orgId: string, patch: Partial<CartRecoverySettings>): Promise<CartRecoverySettings> {
    const cur = await this.getSettings(orgId)
    const next: CartRecoverySettings = {
      ...cur,
      ...patch,
      minutes_after:        clamp(patch.minutes_after        ?? cur.minutes_after,        5, 1440),
      ttl_hours:            clamp(patch.ttl_hours            ?? cur.ttl_hours,            1, 720),
      coupon_discount_pct:  clamp(patch.coupon_discount_pct  ?? cur.coupon_discount_pct,  1, 90),
      coupon_expires_hours: clamp(patch.coupon_expires_hours ?? cur.coupon_expires_hours, 1, 720),
    }
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ cart_recovery_settings: next })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return next
  }

  // ── Tracking público (chamado pela vitrine) ───────────────────────

  /** Upsert do snapshot do carrinho. Identificação preferencial por
   *  phone, fallback email. Quando ambos vazios, retorna no-op (não dá
   *  pra mandar lembrete sem contato). */
  async trackCart(input: {
    slug:           string
    customer_id?:   string | null
    phone?:         string | null
    email?:         string | null
    name?:          string | null
    items:          CartItem[]
    subtotal:       number
    ipHash?:        string | null
  }): Promise<{ tracked: boolean; cartId?: string; reason?: string }> {
    const phone = sanitizePhone(input.phone ?? undefined)
    const email = (input.email ?? '').trim().toLowerCase()
    if (!phone && !email) return { tracked: false, reason: 'no_contact' }

    if (!input.items || input.items.length === 0) {
      // Carrinho vazio: marca o cart como dismissed (cliente esvaziou)
      await this.dismissExisting(input.slug, phone, email)
      return { tracked: false, reason: 'empty_cart' }
    }

    // Resolve org
    const { data: store } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', input.slug)
      .eq('status', 'active')
      .maybeSingle()
    if (!store) return { tracked: false, reason: 'store_not_found' }
    const orgId = (store as { organization_id: string }).organization_id

    // Detecta cart existente (por phone OU email)
    const existing = await this.findExisting(orgId, phone, email)

    const row = {
      organization_id:  orgId,
      store_slug:       input.slug,
      customer_id:      input.customer_id ?? null,
      customer_phone:   phone || null,
      customer_email:   email || null,
      customer_name:    (input.name ?? '').trim() || null,
      items:            input.items,
      subtotal:         input.subtotal,
      status:           'active' as const,
      last_activity_at: new Date().toISOString(),
      reminder_sent_at: null,                   // reset quando carrinho muda
      reminder_dedup_key: null,
      client_ip_hash:   input.ipHash ?? null,
    }

    if (existing) {
      const { error } = await supabaseAdmin
        .from('whatsapp_carts')
        .update(row)
        .eq('id', existing.id)
      if (error) throw new BadRequestException(`Erro: ${error.message}`)
      return { tracked: true, cartId: existing.id }
    }

    const { data, error } = await supabaseAdmin
      .from('whatsapp_carts')
      .insert(row)
      .select('id')
      .maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return { tracked: true, cartId: (data as { id: string }).id }
  }

  /** Cliente esvaziou ou abandonou o carrinho deliberadamente. */
  private async dismissExisting(slug: string, phone: string, email: string): Promise<void> {
    const { data: store } = await supabaseAdmin
      .from('store_config')
      .select('organization_id')
      .eq('store_slug', slug)
      .maybeSingle()
    if (!store) return
    const existing = await this.findExisting((store as { organization_id: string }).organization_id, phone, email)
    if (!existing || existing.status !== 'active') return
    await supabaseAdmin
      .from('whatsapp_carts')
      .update({ status: 'dismissed' })
      .eq('id', existing.id)
  }

  private async findExisting(orgId: string, phone: string, email: string): Promise<{ id: string; status: string } | null> {
    if (phone) {
      const { data } = await supabaseAdmin
        .from('whatsapp_carts')
        .select('id, status')
        .eq('organization_id', orgId)
        .eq('customer_phone', phone)
        .maybeSingle()
      if (data) return data as { id: string; status: string }
    }
    if (email) {
      const { data } = await supabaseAdmin
        .from('whatsapp_carts')
        .select('id, status')
        .eq('organization_id', orgId)
        .ilike('customer_email', email)
        .is('customer_phone', null)
        .maybeSingle()
      if (data) return data as { id: string; status: string }
    }
    return null
  }

  // ── Hook em payments — pedido virou paid → marca cart recovered ───

  async markRecoveredByOrder(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('id, organization_id, customer, customer_id')
        .eq('id', orderId)
        .maybeSingle()
      if (!order) return
      const orgId = (order as { organization_id: string }).organization_id
      const customer = ((order as { customer: { name?: string; phone?: string; email?: string } | null }).customer) ?? {}
      const phone = sanitizePhone(customer.phone)
      const email = (customer.email ?? '').trim().toLowerCase()

      const cart = await this.findExisting(orgId, phone, email)
      if (!cart || cart.status === 'recovered') return

      await supabaseAdmin
        .from('whatsapp_carts')
        .update({
          status:             'recovered',
          recovered_order_id: orderId,
          recovered_at:       new Date().toISOString(),
        })
        .eq('id', cart.id)
      this.logger.log(`[cart-recovery] cart=${cart.id} recovered via order=${orderId}`)
    } catch (e) {
      this.logger.warn(`[cart-recovery] markRecovered falhou order=${orderId}: ${(e as Error).message}`)
    }
  }

  // ── Cron: roda a cada 15 min, dispara lembretes + expira ──────────

  @Cron('0 */15 * * * *') // a cada 15 min (formato 6-campos do nestjs/schedule)
  async runRecoveryTick(): Promise<{ sent: number; expired: number; skipped: number }> {
    let sent = 0, expired = 0, skipped = 0

    // Pega TODAS as orgs com cart_recovery enabled (1 query)
    const { data: configs } = await supabaseAdmin
      .from('store_config')
      .select('organization_id, store_slug, store_name, cart_recovery_settings, public_url')
      .eq('status', 'active')
      .not('cart_recovery_settings', 'is', null)

    const enabledOrgs = ((configs ?? []) as Array<{
      organization_id: string
      store_slug:      string
      store_name:      string
      cart_recovery_settings: Partial<CartRecoverySettings> | null
      public_url:      string | null
    }>).filter(c => {
      const s = c.cart_recovery_settings
      return s && (s.enabled === true)
    })

    if (enabledOrgs.length === 0) return { sent: 0, expired: 0, skipped: 0 }
    this.logger.log(`[cart-recovery] tick start orgs=${enabledOrgs.length}`)

    for (const cfg of enabledOrgs) {
      const settings: CartRecoverySettings = { ...DEFAULT_SETTINGS, ...(cfg.cart_recovery_settings ?? {}) }
      const reminderThreshold = new Date(Date.now() - settings.minutes_after * 60_000).toISOString()
      const expireThreshold = new Date(Date.now() - settings.ttl_hours * 3_600_000).toISOString()

      // Expira tudo que passou do TTL (em qualquer status ativo)
      const { count: expiredCount } = await supabaseAdmin
        .from('whatsapp_carts')
        .update({ status: 'expired' }, { count: 'exact' })
        .eq('organization_id', cfg.organization_id)
        .in('status', ['active', 'sent_reminder'])
        .lt('last_activity_at', expireThreshold)
      expired += expiredCount ?? 0

      // Busca elegíveis pra enviar lembrete
      const { data: targets } = await supabaseAdmin
        .from('whatsapp_carts')
        .select('id, customer_phone, customer_email, customer_name, items, subtotal, items_count')
        .eq('organization_id', cfg.organization_id)
        .eq('status', 'active')
        .is('reminder_sent_at', null)
        .not('customer_phone', 'is', null)
        .lt('last_activity_at', reminderThreshold)
        .limit(100)

      const list = (targets ?? []) as Array<{
        id: string; customer_phone: string; customer_email: string | null
        customer_name: string | null; items: CartItem[]; subtotal: number; items_count: number
      }>

      for (const cart of list) {
        try {
          // AB2 — gera cupom único se habilitado
          const couponCode = settings.coupon_enabled
            ? await this.generateCouponForCart(cfg.organization_id, settings)
            : null

          const message = renderMessage(settings.message_template, {
            name:     cart.customer_name ?? 'cliente',
            store:    cfg.store_name,
            items:    cart.items,
            subtotal: cart.subtotal,
            link:     cfg.public_url ? `${cfg.public_url}/checkout` : `https://eclick.app.br/loja/${cfg.store_slug}/checkout`,
            coupon:   couponCode,
            couponPct: settings.coupon_discount_pct,
          })

          const dedup = `cart_recovery:${cart.id}:${todayStr()}`
          const result = await this.bridge.sendDirectMessage({
            organization_id: cfg.organization_id,
            phone:           cart.customer_phone,
            message,
            dedup_key:       dedup,
          })

          if (result.sent) {
            await supabaseAdmin
              .from('whatsapp_carts')
              .update({
                status:               'sent_reminder',
                reminder_sent_at:     new Date().toISOString(),
                reminder_dedup_key:   dedup,
                reminder_coupon_code: couponCode,
              })
              .eq('id', cart.id)
            sent++
          } else if (result.skipped_no_bridge) {
            // Bridge não disponível — não atualiza, tenta de novo no próximo tick
            skipped++
          } else {
            // Erro do bridge — marca tentativa pra não ficar em loop
            await supabaseAdmin
              .from('whatsapp_carts')
              .update({
                status:               'sent_reminder',
                reminder_sent_at:     new Date().toISOString(),
                reminder_dedup_key:   dedup,
                reminder_coupon_code: couponCode,
              })
              .eq('id', cart.id)
            skipped++
          }
        } catch (e) {
          this.logger.warn(`[cart-recovery] envio falhou cart=${cart.id}: ${(e as Error).message}`)
          skipped++
        }
      }
    }

    this.logger.log(`[cart-recovery] tick done sent=${sent} expired=${expired} skipped=${skipped}`)
    return { sent, expired, skipped }
  }

  // ── Dashboard lojista ─────────────────────────────────────────────

  async listForOwner(orgId: string, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{
    items: WhatsappCart[]
    total: number
    stats: { active: number; sent_reminder: number; recovered: number; expired: number; recovery_rate: number }
  }> {
    const limit  = clamp(opts.limit  ?? 50, 1, 200)
    const offset = clamp(opts.offset ?? 0, 0, 9999)

    let q = supabaseAdmin
      .from('whatsapp_carts')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('updated_at', { ascending: false })
    if (opts.status) q = q.eq('status', opts.status)
    q = q.range(offset, offset + limit - 1)
    const { data, count } = await q

    // Stats (separadas pra não pegar paginação)
    const { data: statRows } = await supabaseAdmin
      .from('whatsapp_carts')
      .select('status')
      .eq('organization_id', orgId)
    const stats = { active: 0, sent_reminder: 0, recovered: 0, expired: 0, recovery_rate: 0 }
    for (const r of (statRows ?? []) as Array<{ status: string }>) {
      if (r.status in stats) (stats as unknown as Record<string, number>)[r.status]++
    }
    const totalSent = stats.sent_reminder + stats.recovered
    stats.recovery_rate = totalSent > 0
      ? Math.round((stats.recovered / totalSent) * 100)
      : 0

    return {
      items: (data ?? []) as unknown as WhatsappCart[],
      total: count ?? 0,
      stats,
    }
  }

  async dismiss(orgId: string, cartId: string): Promise<{ ok: true }> {
    const { data } = await supabaseAdmin
      .from('whatsapp_carts')
      .select('id')
      .eq('id', cartId).eq('organization_id', orgId)
      .maybeSingle()
    if (!data) throw new NotFoundException('Carrinho não encontrado.')
    const { error } = await supabaseAdmin
      .from('whatsapp_carts')
      .update({ status: 'dismissed' })
      .eq('id', cartId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return { ok: true }
  }

  /** Dispara um envio manual ad-hoc pelo lojista (pra um cart específico),
   *  ignorando o cron / threshold. */
  async sendNow(orgId: string, cartId: string): Promise<{ sent: boolean; reason?: string }> {
    const { data: cartRaw } = await supabaseAdmin
      .from('whatsapp_carts')
      .select('*')
      .eq('id', cartId).eq('organization_id', orgId)
      .maybeSingle()
    if (!cartRaw) throw new NotFoundException('Carrinho não encontrado.')
    const cart = cartRaw as unknown as WhatsappCart
    if (!cart.customer_phone) return { sent: false, reason: 'no_phone' }

    const settings = await this.getSettings(orgId)
    const { data: storeRaw } = await supabaseAdmin
      .from('store_config')
      .select('store_name, store_slug, public_url')
      .eq('organization_id', orgId)
      .maybeSingle()
    const store = (storeRaw ?? { store_name: '', store_slug: '', public_url: null }) as {
      store_name: string; store_slug: string; public_url: string | null
    }

    // AB2 — reusa cupom já gerado pro cart, ou gera um novo se habilitado
    const couponCode = cart.reminder_coupon_code
      ?? (settings.coupon_enabled ? await this.generateCouponForCart(orgId, settings) : null)

    const message = renderMessage(settings.message_template, {
      name:     cart.customer_name ?? 'cliente',
      store:    store.store_name,
      items:    cart.items,
      subtotal: cart.subtotal,
      link:     store.public_url ? `${store.public_url}/checkout` : `https://eclick.app.br/loja/${store.store_slug}/checkout`,
      coupon:   couponCode,
      couponPct: settings.coupon_discount_pct,
    })

    const dedup = `cart_recovery:${cart.id}:manual:${todayStr()}`
    const result = await this.bridge.sendDirectMessage({
      organization_id: orgId,
      phone:           cart.customer_phone,
      message,
      dedup_key:       dedup,
    })

    if (result.sent) {
      await supabaseAdmin
        .from('whatsapp_carts')
        .update({
          status:               'sent_reminder',
          reminder_sent_at:     new Date().toISOString(),
          reminder_dedup_key:   dedup,
          reminder_coupon_code: couponCode,
        })
        .eq('id', cart.id)
      return { sent: true }
    }
    return { sent: false, reason: result.skipped_no_bridge ? 'bridge_not_configured' : (result.error ?? 'unknown') }
  }

  /** Gera um cupom único de recovery: % off, 1 uso, expira em N horas.
   *  Código no formato VOLTA{pct}-{rand6}. Retorna o código ou null se
   *  a criação falhar (não bloqueia o envio — manda sem cupom). */
  private async generateCouponForCart(orgId: string, settings: CartRecoverySettings): Promise<string | null> {
    const pct = clamp(settings.coupon_discount_pct, 1, 90)
    const rand = randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
    const code = `VOLTA${pct}-${rand}`
    const expiresAt = new Date(Date.now() + clamp(settings.coupon_expires_hours, 1, 720) * 3_600_000).toISOString()
    try {
      await this.coupons.create(orgId, {
        code,
        type:        'percentage',
        value:       pct,
        usage_limit: 1,
        expires_at:  expiresAt,
        description: `Recovery de carrinho — gerado automaticamente`,
        active:      true,
      })
      return code
    } catch (e) {
      this.logger.warn(`[cart-recovery] falha ao gerar cupom org=${orgId}: ${(e as Error).message}`)
      return null
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function sanitizePhone(raw?: string | null): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 10 ? digits : ''
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}

const DEFAULT_TEMPLATE = (args: {
  name: string; store: string; itemsLine: string; subtotalBRL: string; link: string
  coupon?: string | null; couponPct?: number
}) => {
  const lines = [
    `Oi, ${args.name}! 👋`,
    ``,
    `Vimos que você deixou alguns produtos no carrinho da *${args.store}*:`,
    ``,
    args.itemsLine,
    ``,
    `💰 Total: *${args.subtotalBRL}*`,
  ]
  if (args.coupon) {
    lines.push(
      ``,
      `🎁 Pra te ajudar a decidir, separamos *${args.couponPct ?? 10}% de desconto* só pra você:`,
      `Use o cupom *${args.coupon}* no checkout (validade limitada!).`,
    )
  }
  lines.push(``, `Que tal finalizar? 🛒`, args.link)
  return lines.join('\n')
}

function renderMessage(template: string, ctx: {
  name: string; store: string; items: CartItem[]; subtotal: number; link: string
  coupon?: string | null; couponPct?: number
}): string {
  const itemsLine = ctx.items
    .slice(0, 5)
    .map(i => `• ${i.qty}× ${i.name}`)
    .join('\n') + (ctx.items.length > 5 ? `\n• ...e mais ${ctx.items.length - 5}` : '')
  const subtotalBRL = ctx.subtotal.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  const tpl = (template ?? '').trim()
  if (!tpl) {
    return DEFAULT_TEMPLATE({
      name: ctx.name, store: ctx.store, itemsLine, subtotalBRL,
      link: ctx.link, coupon: ctx.coupon, couponPct: ctx.couponPct,
    })
  }

  // No template custom: {{coupon}} vira o código (ou string vazia se sem cupom)
  const couponText = ctx.coupon ?? ''
  return tpl
    .replace(/\{\{\s*name\s*\}\}/g,     ctx.name)
    .replace(/\{\{\s*store\s*\}\}/g,    ctx.store)
    .replace(/\{\{\s*items\s*\}\}/g,    itemsLine)
    .replace(/\{\{\s*subtotal\s*\}\}/g, subtotalBRL)
    .replace(/\{\{\s*link\s*\}\}/g,     ctx.link)
    .replace(/\{\{\s*coupon\s*\}\}/g,   couponText)
}
