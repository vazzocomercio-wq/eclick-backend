import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import * as crypto from 'node:crypto'
import { AffiliatesService } from './affiliates.service'

/** Atribuição de cliques e vendas a afiliados.
 *
 *  trackClick: registra clique no link do afiliado (com dedup 24h).
 *  attributeOrder: chamado quando pedido vira paid; cria
 *  affiliate_commission baseado no affiliate_id que vem no
 *  storefront_orders.affiliate_id (setado no checkout via cookie).
 *
 *  Idempotente: UNIQUE (affiliate_id, order_id) na affiliate_commissions
 *  previne duplicação se webhook reentregar.
 *
 *  Anti-fraude:
 *   - Email do cliente == email do afiliado → bloqueia, exceto se
 *     settings.allowSelfPurchase=true.
 *   - Dedup de clique: mesmo ip_hash + affiliate_id em 24h = não conta.
 */

const hashIp = (ip: string): string =>
  crypto.createHash('sha256').update(ip + '|eclick-affiliate').digest('hex')

@Injectable()
export class AffiliateAttributionService {
  private readonly logger = new Logger(AffiliateAttributionService.name)

  constructor(private readonly affiliates: AffiliatesService) {}

  /** Registra clique. Resolve afiliado pelo code, valida org status,
   *  faz dedup de 24h por ip_hash. */
  async trackClick(args: {
    slug:         string  // store_slug pra resolver org
    code:         string  // affiliate code do ?ref=
    referrerUrl?: string
    landingUrl?:  string
    userAgent?:   string
    ip?:          string
    customerEmail?: string
    customerId?:    string
  }): Promise<{ tracked: boolean; affiliateId?: string; reason?: string }> {
    if (!args.code) return { tracked: false, reason: 'code ausente' }

    // Resolve org pelo slug
    const { data: store } = await supabaseAdmin
      .from('store_config').select('organization_id, affiliate_settings')
      .eq('store_slug', args.slug).eq('status', 'active').maybeSingle()
    if (!store) return { tracked: false, reason: 'loja não encontrada' }

    const orgId = (store as { organization_id: string }).organization_id
    const settings = (store as { affiliate_settings?: Record<string, unknown> | null }).affiliate_settings
    if (!settings || (settings as { enabled?: boolean }).enabled !== true) {
      return { tracked: false, reason: 'programa de afiliados desativado' }
    }

    // Resolve afiliado pelo code
    const { data: aff } = await supabaseAdmin
      .from('affiliates').select('id, status')
      .eq('organization_id', orgId)
      .eq('code', args.code.toLowerCase())
      .maybeSingle()
    if (!aff) return { tracked: false, reason: 'afiliado não encontrado' }
    if ((aff as { status: string }).status !== 'approved') {
      return { tracked: false, reason: 'afiliado não aprovado' }
    }

    const affiliateId = (aff as { id: string }).id
    const ipHash = args.ip ? hashIp(args.ip) : null

    // Dedup 24h: mesmo ip + affiliate em 24h = não conta
    if (ipHash) {
      const cutoff = new Date(Date.now() - 86400_000).toISOString()
      const { count } = await supabaseAdmin
        .from('affiliate_clicks').select('*', { count: 'exact', head: true })
        .eq('affiliate_id', affiliateId).eq('ip_hash', ipHash)
        .gte('created_at', cutoff)
      if ((count ?? 0) > 0) {
        return { tracked: false, affiliateId, reason: 'dedup_24h' }
      }
    }

    const customerEmailHash = args.customerEmail
      ? crypto.createHash('sha256').update(args.customerEmail.toLowerCase()).digest('hex')
      : null

    // INSERT click
    const { error } = await supabaseAdmin.from('affiliate_clicks').insert({
      affiliate_id:         affiliateId,
      organization_id:      orgId,
      referrer_url:         args.referrerUrl?.slice(0, 500) ?? null,
      landing_url:          args.landingUrl?.slice(0, 500) ?? null,
      user_agent:           args.userAgent?.slice(0, 500) ?? null,
      ip_hash:              ipHash,
      customer_email_hash:  customerEmailHash,
      customer_id:          args.customerId ?? null,
    })
    if (error) {
      this.logger.warn(`[affiliate.click] insert falhou: ${error.message}`)
      return { tracked: false, reason: error.message }
    }

    // Incrementa counter denormalizado (best-effort)
    void this.incrementCounter(affiliateId, 'total_clicks', 1).catch(() => undefined)

    return { tracked: true, affiliateId }
  }

  /** Chamado quando pedido vira 'paid'. Lê storefront_orders.affiliate_id
   *  e cria affiliate_commission status=pending. Idempotente. */
  async attributeOrder(orderId: string): Promise<{ created: boolean; reason?: string; commissionId?: string }> {
    const { data: order } = await supabaseAdmin
      .from('storefront_orders')
      .select('id, organization_id, total, customer, affiliate_id, status')
      .eq('id', orderId).maybeSingle()
    if (!order) return { created: false, reason: 'pedido não encontrado' }
    if ((order as { status: string }).status !== 'paid') return { created: false, reason: 'pedido não está pago' }
    const affiliateId = (order as { affiliate_id: string | null }).affiliate_id
    if (!affiliateId) return { created: false, reason: 'sem afiliado atribuído' }

    const orgId = (order as { organization_id: string }).organization_id
    const settings = await this.affiliates.getSettings(orgId)
    if (!settings.enabled) return { created: false, reason: 'programa desativado' }

    // Carrega afiliado pra checar status + pct custom
    const { data: aff } = await supabaseAdmin
      .from('affiliates').select('id, email, status, custom_commission_pct, total_orders, total_earned_cents')
      .eq('id', affiliateId).eq('organization_id', orgId).maybeSingle()
    if (!aff) return { created: false, reason: 'afiliado não existe mais' }
    if ((aff as { status: string }).status !== 'approved') {
      return { created: false, reason: 'afiliado não aprovado' }
    }

    // Anti-fraude: self-purchase
    const customer = (order as { customer: Record<string, unknown> | null }).customer ?? {}
    const customerEmail = ((customer as { email?: string }).email ?? '').trim().toLowerCase()
    const affEmail = ((aff as { email: string }).email ?? '').toLowerCase()
    if (!settings.allowSelfPurchase && customerEmail && customerEmail === affEmail) {
      return { created: false, reason: 'self-purchase bloqueada' }
    }

    const total = Number((order as { total: number }).total ?? 0)
    if (total <= 0) return { created: false, reason: 'pedido sem valor' }
    const orderTotalCents = Math.round(total * 100)

    const pct = ((aff as { custom_commission_pct: number | null }).custom_commission_pct
                  ?? settings.defaultCommissionPct)
    const amountCents = Math.round((orderTotalCents * pct) / 100)
    if (amountCents <= 0) return { created: false, reason: 'comissão calculada = 0' }

    // INSERT idempotente — UNIQUE(affiliate_id, order_id) previne duplicação
    const { data, error } = await supabaseAdmin
      .from('affiliate_commissions').insert({
        affiliate_id:      affiliateId,
        organization_id:   orgId,
        order_id:          orderId,
        order_total_cents: orderTotalCents,
        commission_pct:    pct,
        amount_cents:      amountCents,
        status:            'pending',
      }).select('id').maybeSingle()

    if (error) {
      const code = (error as { code?: string }).code
      if (code === '23505') return { created: false, reason: 'já atribuído (idempotência)' }
      this.logger.warn(`[affiliate.attr] insert falhou order=${orderId}: ${error.message}`)
      return { created: false, reason: error.message }
    }

    // Incrementa counters denormalizados
    void this.incrementCounter(affiliateId, 'total_orders', 1).catch(() => undefined)
    void this.incrementCounter(affiliateId, 'total_earned_cents', amountCents).catch(() => undefined)

    this.logger.log(`[affiliate.attr] +${amountCents}c (${pct}%) order=${orderId} → affiliate=${affiliateId}`)
    return { created: true, commissionId: (data as { id?: string } | null)?.id }
  }

  /** Cron diário: comissões com refund_window_days vencido viram approved. */
  async approveExpiredCommissions(now = new Date()): Promise<{ approved: number; orgsScanned: number }> {
    // Pega settings de todas as orgs com programa enabled
    const { data: configs } = await supabaseAdmin
      .from('store_config').select('organization_id, affiliate_settings')
    const orgs = ((configs ?? []) as Array<{ organization_id: string; affiliate_settings: Record<string, unknown> | null }>)
      .filter(c => (c.affiliate_settings as { enabled?: boolean } | null)?.enabled)

    if (orgs.length === 0) return { approved: 0, orgsScanned: 0 }

    let approved = 0
    for (const o of orgs) {
      const settings = (o.affiliate_settings as { refundWindowDays?: number } | null) ?? {}
      const window = settings.refundWindowDays ?? 30
      const cutoff = new Date(now.getTime() - window * 86400_000).toISOString()

      const { data: pendings } = await supabaseAdmin
        .from('affiliate_commissions')
        .select('id')
        .eq('organization_id', o.organization_id)
        .eq('status', 'pending')
        .lte('created_at', cutoff)
        .limit(1000)

      const ids = ((pendings ?? []) as Array<{ id: string }>).map(r => r.id)
      if (ids.length === 0) continue

      const { error } = await supabaseAdmin
        .from('affiliate_commissions')
        .update({ status: 'approved', approved_at: now.toISOString() })
        .in('id', ids)
      if (error) {
        this.logger.warn(`[affiliate.cron.approve] org=${o.organization_id}: ${error.message}`)
        continue
      }
      approved += ids.length
    }

    this.logger.log(`[affiliate.cron.approve] ${approved} comissões aprovadas em ${orgs.length} orgs`)
    return { approved, orgsScanned: orgs.length }
  }

  /** Quando pedido vira 'refunded' / 'cancelled' depois de já ter
   *  comissão criada → marca como refunded (não deve mais ser paga). */
  async refundCommissions(orderId: string): Promise<{ refunded: number }> {
    const { data, error, count } = await supabaseAdmin
      .from('affiliate_commissions')
      .update({ status: 'refunded' }, { count: 'exact' })
      .eq('order_id', orderId)
      .in('status', ['pending', 'approved'])
      .select('amount_cents, affiliate_id')
    if (error) throw new BadRequestException(`Erro: ${error.message}`)

    // Decrementa counters denormalizados
    for (const r of (data ?? []) as Array<{ amount_cents: number; affiliate_id: string }>) {
      await this.incrementCounter(r.affiliate_id, 'total_earned_cents', -Number(r.amount_cents)).catch(() => undefined)
      await this.incrementCounter(r.affiliate_id, 'total_orders', -1).catch(() => undefined)
    }
    return { refunded: count ?? 0 }
  }

  private async incrementCounter(affiliateId: string, field: 'total_clicks' | 'total_orders' | 'total_earned_cents', delta: number): Promise<void> {
    const { data } = await supabaseAdmin
      .from('affiliates').select(field).eq('id', affiliateId).maybeSingle()
    if (!data) return
    const cur = Number((data as Record<string, number>)[field] ?? 0)
    await supabaseAdmin.from('affiliates')
      .update({ [field]: Math.max(0, cur + delta), last_activity_at: new Date().toISOString() })
      .eq('id', affiliateId)
  }
}
