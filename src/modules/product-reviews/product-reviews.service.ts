import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../common/supabase'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'

/**
 * Z1 — Avaliações de produtos da Loja Própria.
 *
 * Quem pode avaliar:
 *   - Cliente storefront que tem um storefront_order com:
 *       status='paid' AND shipping_status='delivered'
 *   - O produto avaliado precisa estar em order.items.
 *   - 1 review por (customer_id, product_id, order_id) — guarda via
 *     UNIQUE index na migration.
 *
 * Estados:
 *   - pending: aguarda moderação do lojista
 *   - approved: visível na vitrine; entra no agregado review_count/avg
 *   - rejected: oculta; não entra no agregado
 *
 * `auto_approve` em store_config.review_settings ativa aprovação na
 * hora de criar (review entra como approved + auto_approved=true).
 *
 * Após qualquer mudança de estado relevante (create approved, approve,
 * reject, delete), chama `recompute_product_review_aggregate(product_id)`
 * pra atualizar denormalização em products.
 */

export interface ReviewSettings {
  auto_approve:              boolean
  min_body_chars:            number
  max_photos:                number
  ask_after_days:            number
  hide_customer_full_name:   boolean
  /** AE1 — quando true, o cron diário manda WhatsApp pós-entrega
   *  convidando o cliente a avaliar (depois de ask_after_days). */
  invite_enabled:            boolean
}

const DEFAULT_SETTINGS: ReviewSettings = {
  auto_approve:            false,
  min_body_chars:          20,
  max_photos:              3,
  ask_after_days:          3,
  hide_customer_full_name: true,
  invite_enabled:          false,
}

export interface ProductReview {
  id:                  string
  organization_id:     string
  product_id:          string
  customer_id:         string
  order_id:            string | null
  rating:              number
  title:               string | null
  body:                string
  photos:              Array<{ url: string; width?: number; height?: number }>
  status:              'pending' | 'approved' | 'rejected'
  store_reply:         string | null
  store_reply_at:      string | null
  helpful_count:       number
  approved_at:         string | null
  rejected_at:         string | null
  rejection_reason:    string | null
  auto_approved:       boolean
  created_at:          string
  updated_at:          string
}

interface OrderItemRow {
  productId:  string
  name?:      string
  price?:     number
  qty?:       number
  imageUrl?:  string
}

interface OrderRow {
  id:               string
  status:           string
  shipping_status:  string | null
  delivered_at:     string | null
  items:            OrderItemRow[] | null
  organization_id:  string
}

@Injectable()
export class ProductReviewsService {
  private readonly logger = new Logger(ProductReviewsService.name)

  constructor(private readonly bridge: ActiveBridgeClient) {}

  // ── Settings ──────────────────────────────────────────────────────

  async getSettings(orgId: string): Promise<ReviewSettings> {
    const { data } = await supabaseAdmin
      .from('store_config')
      .select('review_settings')
      .eq('organization_id', orgId)
      .maybeSingle()
    const raw = (data?.review_settings ?? {}) as Partial<ReviewSettings>
    return { ...DEFAULT_SETTINGS, ...raw }
  }

  async updateSettings(orgId: string, patch: Partial<ReviewSettings>): Promise<ReviewSettings> {
    const current = await this.getSettings(orgId)
    const next: ReviewSettings = {
      ...current,
      ...patch,
      min_body_chars: clamp(patch.min_body_chars ?? current.min_body_chars, 0, 500),
      max_photos:     clamp(patch.max_photos     ?? current.max_photos,     0, 10),
      ask_after_days: clamp(patch.ask_after_days ?? current.ask_after_days, 0, 60),
    }
    const { error } = await supabaseAdmin
      .from('store_config')
      .update({ review_settings: next })
      .eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return next
  }

  // ── Cliente público: criar review ─────────────────────────────────

  /** Cliente storefront submete avaliação. Valida elegibilidade
   *  (pedido pago + entregue + produto no pedido). */
  async createForCustomer(args: {
    orgId:       string
    customerId:  string
    orderId:     string
    productId:   string
    rating:      number
    title?:      string
    body:        string
    photos?:     Array<{ url: string; width?: number; height?: number }>
  }): Promise<ProductReview> {
    const settings = await this.getSettings(args.orgId)

    // Validações básicas
    if (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5) {
      throw new BadRequestException('Avaliação deve ser de 1 a 5 estrelas.')
    }
    const body = (args.body ?? '').trim()
    if (body.length < settings.min_body_chars) {
      throw new BadRequestException(`Escreva pelo menos ${settings.min_body_chars} caracteres.`)
    }
    const photos = (args.photos ?? []).slice(0, settings.max_photos).filter(p => p?.url)

    // Verifica que o pedido pertence ao cliente, é desta loja, e foi entregue
    const { data: orderRaw } = await supabaseAdmin
      .from('storefront_orders')
      .select('id, status, shipping_status, delivered_at, items, organization_id, customer_id')
      .eq('id', args.orderId)
      .eq('organization_id', args.orgId)
      .maybeSingle()
    if (!orderRaw) throw new NotFoundException('Pedido não encontrado.')
    const order = orderRaw as unknown as OrderRow & { customer_id: string | null }
    if (order.customer_id && order.customer_id !== args.customerId) {
      throw new ForbiddenException('Você não pode avaliar pedido de outro cliente.')
    }
    if (order.status !== 'paid' && order.status !== 'refunded') {
      throw new BadRequestException('Só dá pra avaliar pedido pago.')
    }
    if (order.shipping_status !== 'delivered') {
      throw new BadRequestException('Só dá pra avaliar depois que o pedido foi entregue.')
    }
    const items: OrderItemRow[] = Array.isArray(order.items) ? order.items : []
    const matched = items.find(i => i?.productId === args.productId)
    if (!matched) throw new BadRequestException('Este produto não está nesse pedido.')

    // Detecta duplicata explicitamente (UNIQUE também protege, mas msg melhor)
    const { data: existing } = await supabaseAdmin
      .from('product_reviews')
      .select('id, status')
      .eq('customer_id',  args.customerId)
      .eq('product_id',   args.productId)
      .eq('order_id',     args.orderId)
      .maybeSingle()
    if (existing) throw new BadRequestException('Você já avaliou este produto neste pedido.')

    const willAutoApprove = settings.auto_approve
    const now = new Date().toISOString()
    const insert = {
      organization_id:  args.orgId,
      product_id:       args.productId,
      customer_id:      args.customerId,
      order_id:         args.orderId,
      rating:           args.rating,
      title:            (args.title ?? '').trim() || null,
      body,
      photos,
      status:           willAutoApprove ? 'approved' : 'pending',
      auto_approved:    willAutoApprove,
      approved_at:      willAutoApprove ? now : null,
    }

    const { data, error } = await supabaseAdmin
      .from('product_reviews')
      .insert(insert)
      .select('*')
      .maybeSingle()
    if (error || !data) {
      const code = (error as { code?: string } | null)?.code
      if (code === '23505') throw new BadRequestException('Você já avaliou este produto.')
      throw new BadRequestException(`Erro ao salvar avaliação: ${error?.message ?? '?'}`)
    }
    if (willAutoApprove) {
      await this.recomputeAggregate(args.productId)
    }
    this.logger.log(`[reviews] org=${args.orgId} customer=${args.customerId} product=${args.productId} status=${insert.status}`)
    return data as unknown as ProductReview
  }

  /** Lista items que o cliente pode avaliar agora (delivered, não-avaliados). */
  async listEligibleForCustomer(orgId: string, customerId: string): Promise<Array<{
    orderId:     string
    productId:   string
    productName: string
    imageUrl?:   string
    deliveredAt: string | null
  }>> {
    const { data: orders } = await supabaseAdmin
      .from('storefront_orders')
      .select('id, items, delivered_at, shipping_status, customer_id')
      .eq('organization_id',  orgId)
      .eq('customer_id',      customerId)
      .eq('shipping_status', 'delivered')
      .order('delivered_at', { ascending: false })
      .limit(60)

    const rows = (orders ?? []) as unknown as Array<{
      id: string; items: OrderItemRow[] | null; delivered_at: string | null
    }>

    // Cria candidatos (orderId, productId)
    const candidates: Array<{ orderId: string; productId: string; productName: string; imageUrl?: string; deliveredAt: string | null }> = []
    for (const o of rows) {
      const items: OrderItemRow[] = Array.isArray(o.items) ? o.items : []
      for (const it of items) {
        if (!it?.productId) continue
        candidates.push({
          orderId:     o.id,
          productId:   it.productId,
          productName: it.name ?? '',
          imageUrl:    it.imageUrl,
          deliveredAt: o.delivered_at,
        })
      }
    }
    if (candidates.length === 0) return []

    // Quais (order, product) já têm review?
    const orderIds = Array.from(new Set(candidates.map(c => c.orderId)))
    const productIds = Array.from(new Set(candidates.map(c => c.productId)))
    const { data: existing } = await supabaseAdmin
      .from('product_reviews')
      .select('order_id, product_id')
      .eq('customer_id', customerId)
      .in('order_id',  orderIds)
      .in('product_id', productIds)
    const reviewedKey = new Set(
      ((existing ?? []) as Array<{ order_id: string; product_id: string }>)
        .map(r => `${r.order_id}|${r.product_id}`),
    )

    return candidates.filter(c => !reviewedKey.has(`${c.orderId}|${c.productId}`))
  }

  /** Lista as próprias reviews do cliente (qualquer status). */
  async listForCustomer(customerId: string): Promise<ProductReview[]> {
    const { data } = await supabaseAdmin
      .from('product_reviews')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(200)
    return (data ?? []) as unknown as ProductReview[]
  }

  // ── Vitrine pública: listar reviews aprovadas de um produto ───────

  async listPublicByProduct(orgId: string, productId: string, opts: { limit?: number; offset?: number } = {}): Promise<{
    items: Array<{
      id:            string
      rating:        number
      title:         string | null
      body:          string
      photos:        Array<{ url: string }>
      store_reply:   string | null
      helpful_count: number
      created_at:    string
      customer:      { display_name: string }
    }>
    total:        number
    summary:      { avg: number | null; count: number; distribution: Record<string, number> }
  }> {
    const limit  = clamp(opts.limit  ?? 10, 1, 50)
    const offset = clamp(opts.offset ?? 0, 0, 9999)

    const settings = await this.getSettings(orgId)

    const { data, count } = await supabaseAdmin
      .from('product_reviews')
      .select('id, rating, title, body, photos, store_reply, helpful_count, created_at, customer_id', { count: 'exact' })
      .eq('product_id', productId)
      .eq('status', 'approved')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    const rows = (data ?? []) as Array<{ id: string; rating: number; title: string | null; body: string; photos: Array<{ url: string }> | null; store_reply: string | null; helpful_count: number; created_at: string; customer_id: string }>
    const customerIds = Array.from(new Set(rows.map(r => r.customer_id)))
    let nameMap = new Map<string, string>()
    if (customerIds.length > 0) {
      const { data: customers } = await supabaseAdmin
        .from('storefront_customers')
        .select('id, name')
        .in('id', customerIds)
      nameMap = new Map(((customers ?? []) as Array<{ id: string; name: string }>).map(c => [c.id, c.name]))
    }

    const items = rows.map(r => ({
      id:            r.id,
      rating:        r.rating,
      title:         r.title,
      body:          r.body,
      photos:        Array.isArray(r.photos) ? r.photos : [],
      store_reply:   r.store_reply,
      helpful_count: r.helpful_count,
      created_at:    r.created_at,
      customer:      { display_name: displayName(nameMap.get(r.customer_id) ?? 'Cliente', settings.hide_customer_full_name) },
    }))

    // Agregado: pega do products (denormalizado) + distribution real
    const { data: aggRaw } = await supabaseAdmin
      .from('products')
      .select('review_count, review_avg')
      .eq('id', productId)
      .maybeSingle()
    const agg = aggRaw as { review_count: number | null; review_avg: number | null } | null

    // Distribution (5→1 estrelas) — calcula on-demand pra esta página
    const { data: distRaw } = await supabaseAdmin
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId)
      .eq('status', 'approved')
    const distRows = (distRaw ?? []) as Array<{ rating: number }>
    const distribution: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 }
    for (const r of distRows) {
      const key = String(r.rating)
      if (key in distribution) distribution[key] = (distribution[key] ?? 0) + 1
    }

    return {
      items,
      total: count ?? 0,
      summary: {
        avg:   agg?.review_avg ?? null,
        count: agg?.review_count ?? 0,
        distribution,
      },
    }
  }

  // ── Lojista: moderação ────────────────────────────────────────────

  async listForOwner(orgId: string, opts: { status?: 'pending' | 'approved' | 'rejected'; productId?: string; limit?: number; offset?: number } = {}): Promise<{ items: Array<ProductReview & { product?: { id: string; name: string; photo_urls: string[] | null }; customer?: { id: string; name: string; email: string } }>; total: number }> {
    const limit  = clamp(opts.limit  ?? 50, 1, 200)
    const offset = clamp(opts.offset ?? 0, 0, 9999)
    let q = supabaseAdmin
      .from('product_reviews')
      .select('*', { count: 'exact' })
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (opts.status)    q = q.eq('status', opts.status)
    if (opts.productId) q = q.eq('product_id', opts.productId)
    q = q.range(offset, offset + limit - 1)
    const { data, count } = await q

    const reviews = (data ?? []) as unknown as ProductReview[]
    if (reviews.length === 0) return { items: [], total: count ?? 0 }

    // Hydrate product + customer
    const productIds  = Array.from(new Set(reviews.map(r => r.product_id)))
    const customerIds = Array.from(new Set(reviews.map(r => r.customer_id)))
    const [{ data: products }, { data: customers }] = await Promise.all([
      supabaseAdmin.from('products').select('id, name, photo_urls').in('id', productIds).eq('organization_id', orgId),
      supabaseAdmin.from('storefront_customers').select('id, name, email').in('id', customerIds).eq('organization_id', orgId),
    ])
    const productMap  = new Map(((products  ?? []) as Array<{ id: string; name: string; photo_urls: string[] | null }>).map(p => [p.id, p]))
    const customerMap = new Map(((customers ?? []) as Array<{ id: string; name: string; email: string }>).map(c => [c.id, c]))

    return {
      items: reviews.map(r => ({
        ...r,
        product:  productMap.get(r.product_id),
        customer: customerMap.get(r.customer_id),
      })),
      total: count ?? 0,
    }
  }

  async approve(orgId: string, reviewId: string): Promise<ProductReview> {
    const review = await this.getOwned(orgId, reviewId)
    if (review.status === 'approved') return review
    const { data, error } = await supabaseAdmin
      .from('product_reviews')
      .update({
        status:      'approved',
        approved_at: new Date().toISOString(),
        rejected_at: null,
        rejection_reason: null,
      })
      .eq('id', reviewId).eq('organization_id', orgId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    await this.recomputeAggregate(review.product_id)
    return data as unknown as ProductReview
  }

  async reject(orgId: string, reviewId: string, reason?: string): Promise<ProductReview> {
    const review = await this.getOwned(orgId, reviewId)
    const wasApproved = review.status === 'approved'
    const { data, error } = await supabaseAdmin
      .from('product_reviews')
      .update({
        status:           'rejected',
        rejected_at:      new Date().toISOString(),
        rejection_reason: (reason ?? '').trim() || null,
      })
      .eq('id', reviewId).eq('organization_id', orgId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    if (wasApproved) await this.recomputeAggregate(review.product_id)
    return data as unknown as ProductReview
  }

  async reply(orgId: string, reviewId: string, text: string): Promise<ProductReview> {
    await this.getOwned(orgId, reviewId)
    const trimmed = (text ?? '').trim()
    if (!trimmed) throw new BadRequestException('Resposta vazia.')
    const { data, error } = await supabaseAdmin
      .from('product_reviews')
      .update({
        store_reply:    trimmed,
        store_reply_at: new Date().toISOString(),
      })
      .eq('id', reviewId).eq('organization_id', orgId)
      .select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? '?'}`)
    return data as unknown as ProductReview
  }

  async remove(orgId: string, reviewId: string): Promise<{ ok: true }> {
    const review = await this.getOwned(orgId, reviewId)
    const wasApproved = review.status === 'approved'
    const { error } = await supabaseAdmin
      .from('product_reviews')
      .delete()
      .eq('id', reviewId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (wasApproved) await this.recomputeAggregate(review.product_id)
    return { ok: true }
  }

  /** Métricas pro card do hub. */
  async stats(orgId: string): Promise<{
    pending: number; approved: number; rejected: number; total: number
    avg_overall: number | null
  }> {
    const { data: rows } = await supabaseAdmin
      .from('product_reviews')
      .select('status, rating')
      .eq('organization_id', orgId)
    const arr = (rows ?? []) as Array<{ status: string; rating: number }>
    const stats = { pending: 0, approved: 0, rejected: 0, total: arr.length, avg_overall: null as number | null }
    let sum = 0
    let approvedCount = 0
    for (const r of arr) {
      if (r.status === 'pending')  stats.pending++
      if (r.status === 'approved') { stats.approved++; sum += r.rating; approvedCount++ }
      if (r.status === 'rejected') stats.rejected++
    }
    stats.avg_overall = approvedCount > 0 ? Math.round((sum / approvedCount) * 100) / 100 : null
    return stats
  }

  // ── AE1: Cron de convite pra avaliar (WhatsApp pós-entrega) ───────

  /** Roda 1x/dia (11:00 BRT = 14:00 UTC). Pra cada org com
   *  review_settings.invite_enabled, acha pedidos entregues há
   *  `ask_after_days` dias e ainda sem convite enviado, e manda
   *  WhatsApp convidando o cliente a avaliar. Marca
   *  review_invite_sent_at pra não duplicar. */
  @Cron('0 0 14 * * *') // 14:00 UTC = 11:00 BRT (6-campos nestjs/schedule)
  async runReviewInviteTick(): Promise<{ sent: number; skipped: number }> {
    let sent = 0, skipped = 0

    const { data: configs } = await supabaseAdmin
      .from('store_config')
      .select('organization_id, store_slug, store_name, review_settings, public_url')
      .eq('status', 'active')

    const enabledOrgs = ((configs ?? []) as Array<{
      organization_id: string; store_slug: string; store_name: string
      review_settings: Partial<ReviewSettings> | null; public_url: string | null
    }>).filter(c => (c.review_settings?.invite_enabled === true))

    if (enabledOrgs.length === 0) return { sent: 0, skipped: 0 }
    this.logger.log(`[review-invite] tick start orgs=${enabledOrgs.length}`)

    for (const cfg of enabledOrgs) {
      const settings: ReviewSettings = { ...DEFAULT_SETTINGS, ...(cfg.review_settings ?? {}) }
      const askDays = clamp(settings.ask_after_days, 0, 60)
      const threshold = new Date(Date.now() - askDays * 86_400_000).toISOString()

      // Pedidos entregues há >= askDays, pagos, sem convite enviado
      const { data: orders } = await supabaseAdmin
        .from('storefront_orders')
        .select('id, customer, items, delivered_at')
        .eq('organization_id', cfg.organization_id)
        .eq('status', 'paid')
        .eq('shipping_status', 'delivered')
        .is('review_invite_sent_at', null)
        .lte('delivered_at', threshold)
        .order('delivered_at', { ascending: true })
        .limit(50)

      const list = (orders ?? []) as Array<{
        id: string
        customer: { name?: string; phone?: string } | null
        items: OrderItemRow[] | null
        delivered_at: string | null
      }>

      for (const order of list) {
        const customer = order.customer ?? {}
        const phone = sanitizePhone(customer.phone)
        const items: OrderItemRow[] = Array.isArray(order.items) ? order.items : []
        const productCount = items.length

        // Sem telefone → marca como enviado (não dá pra mandar; evita
        // re-processar todo dia)
        if (!phone || productCount === 0) {
          await supabaseAdmin
            .from('storefront_orders')
            .update({ review_invite_sent_at: new Date().toISOString() })
            .eq('id', order.id)
          skipped++
          continue
        }

        const link = cfg.public_url
          ? `${cfg.public_url}/conta`
          : `https://eclick.app.br/loja/${cfg.store_slug}/conta`

        const firstName = (customer.name ?? 'cliente').trim().split(/\s+/)[0]
        const productLabel = productCount === 1
          ? `o produto que você comprou`
          : `os ${productCount} produtos que você comprou`

        const message = [
          `Oi, ${firstName}! 🌟`,
          ``,
          `Esperamos que você esteja amando ${productLabel} na *${cfg.store_name}*.`,
          ``,
          `Que tal contar pra outros clientes o que achou? Sua avaliação ajuda demais — e leva menos de 1 minuto! 🙏`,
          ``,
          `Avalie aqui:`,
          link,
        ].join('\n')

        try {
          const result = await this.bridge.sendDirectMessage({
            organization_id: cfg.organization_id,
            phone,
            message,
            dedup_key:       `review_invite:${order.id}`,
          })
          // Marca como enviado em qualquer caso (sent ou skip do bridge)
          // pra não floodar — exceto quando bridge indisponível (retry amanhã)
          if (result.skipped_no_bridge) {
            skipped++
          } else {
            await supabaseAdmin
              .from('storefront_orders')
              .update({ review_invite_sent_at: new Date().toISOString() })
              .eq('id', order.id)
            if (result.sent) sent++; else skipped++
          }
        } catch (e) {
          this.logger.warn(`[review-invite] envio falhou order=${order.id}: ${(e as Error).message}`)
          skipped++
        }
      }
    }

    this.logger.log(`[review-invite] tick done sent=${sent} skipped=${skipped}`)
    return { sent, skipped }
  }

  // ── Helpers internos ──────────────────────────────────────────────

  private async getOwned(orgId: string, reviewId: string): Promise<ProductReview> {
    const { data } = await supabaseAdmin
      .from('product_reviews')
      .select('*')
      .eq('id', reviewId).eq('organization_id', orgId)
      .maybeSingle()
    if (!data) throw new NotFoundException('Avaliação não encontrada.')
    return data as unknown as ProductReview
  }

  private async recomputeAggregate(productId: string): Promise<void> {
    const { error } = await supabaseAdmin
      .rpc('recompute_product_review_aggregate', { p_product_id: productId })
    if (error) this.logger.warn(`[reviews] recompute falhou produto=${productId}: ${error.message}`)
  }
}

// ── Utilitários ─────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.floor(n)))
}

/** Sanitiza telefone — só dígitos. Retorna '' se ficar curto demais. */
function sanitizePhone(raw?: string | null): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 10 ? digits : ''
}

/** Pra LGPD: por default exibe só primeiro nome + inicial do sobrenome.
 *  Ex.: "Maria Silva Santos" → "Maria S.". Quando `hide=false`, mostra full. */
function displayName(full: string, hide: boolean): string {
  const trimmed = (full ?? '').trim()
  if (!trimmed) return 'Cliente'
  if (!hide) return trimmed
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return parts[0]!
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`
}
