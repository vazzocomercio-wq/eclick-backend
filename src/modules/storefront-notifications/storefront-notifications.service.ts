import { Injectable, Logger } from '@nestjs/common'
import { ActiveBridgeClient } from '../active-bridge/active-bridge.client'
import { supabaseAdmin } from '../../common/supabase'

/** Notificações WhatsApp transacionais da Loja Própria.
 *
 *  Dispara em momentos-chave do fluxo:
 *   - Pedido pago → "✅ Recebemos seu pagamento!"
 *   - Pedido enviado → "📦 Seu pedido foi enviado! Código de rastreio: X"
 *   - Pedido entregue → "🎉 Seu pedido chegou! Avalie sua experiência"
 *   - Promoção de tier → "⭐ Você virou Ouro!"
 *
 *  Todas as chamadas:
 *  - São silenciosas em caso de erro (log + skip — notificação é opcional)
 *  - Idempotentes via dedup_key (Active armazena pra evitar reenvio)
 *  - Respeitam telefone do customer (pula se não tem phone)
 *
 *  Endpoint Active esperado:
 *    POST /commerce/automation-bridge/send-direct
 *      { organization_id, phone, message, dedup_key }
 *
 *  Se Active ainda não tem o endpoint, ActiveBridgeClient.sendDirectMessage
 *  retorna {skipped_no_bridge: true} silenciosamente.
 */

@Injectable()
export class StorefrontNotificationsService {
  private readonly logger = new Logger(StorefrontNotificationsService.name)

  constructor(private readonly bridge: ActiveBridgeClient) {}

  /** Dispara depois de pagamento confirmado pelo gateway. */
  async notifyOrderPaid(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('id, organization_id, store_slug, customer, total, items, status')
        .eq('id', orderId)
        .maybeSingle()
      if (!order || (order.status as string) !== 'paid') return
      const customer = (order.customer as { name?: string; phone?: string } | null) ?? {}
      const phone = sanitizePhone(customer.phone)
      if (!phone) return

      const storeName = await this.getStoreName(order.organization_id as string)
      const itemCount = Array.isArray(order.items) ? (order.items as unknown[]).length : 0
      const total = Number(order.total ?? 0)

      const message = [
        `✅ Olá, ${customer.name ?? 'cliente'}!`,
        ``,
        `Recebemos seu pagamento na *${storeName}*. Obrigado!`,
        ``,
        `📦 Pedido *#${(order.id as string).slice(0, 8).toUpperCase()}*`,
        `🛍️ ${itemCount} ${itemCount === 1 ? 'item' : 'itens'} · ${formatBRL(total)}`,
        ``,
        `Em breve te enviamos o código de rastreio. 🚚`,
      ].join('\n')

      await this.bridge.sendDirectMessage({
        organization_id: order.organization_id as string,
        phone,
        message,
        dedup_key:       `storefront_order:${orderId}:paid`,
      })
    } catch (err) {
      this.logger.warn(`[notify.paid] order=${orderId}: ${(err as Error).message}`)
    }
  }

  /** Dispara quando lojista marca como enviado (com tracking opcional). */
  async notifyOrderShipped(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('id, organization_id, customer, tracking_code, shipping_carrier, store_slug')
        .eq('id', orderId)
        .maybeSingle()
      if (!order) return
      const customer = (order.customer as { name?: string; phone?: string } | null) ?? {}
      const phone = sanitizePhone(customer.phone)
      if (!phone) return

      const storeName = await this.getStoreName(order.organization_id as string)
      const lines = [
        `📦 Olá, ${customer.name ?? 'cliente'}!`,
        ``,
        `Seu pedido da *${storeName}* foi enviado!`,
        ``,
        `Pedido *#${(order.id as string).slice(0, 8).toUpperCase()}*`,
      ]
      if (order.tracking_code) {
        lines.push(``, `🔎 Código de rastreio: *${order.tracking_code}*`)
        if (order.shipping_carrier) lines.push(`Transportadora: ${order.shipping_carrier}`)
      }
      lines.push(``, `Vamos te avisar quando chegar! 🚚`)

      await this.bridge.sendDirectMessage({
        organization_id: order.organization_id as string,
        phone,
        message:         lines.join('\n'),
        dedup_key:       `storefront_order:${orderId}:shipped`,
      })
    } catch (err) {
      this.logger.warn(`[notify.shipped] order=${orderId}: ${(err as Error).message}`)
    }
  }

  /** Dispara quando pedido vira 'delivered'. Inclui CTA pra cashback ganho. */
  async notifyOrderDelivered(orderId: string): Promise<void> {
    try {
      const { data: order } = await supabaseAdmin
        .from('storefront_orders')
        .select('id, organization_id, customer, total, store_slug')
        .eq('id', orderId)
        .maybeSingle()
      if (!order) return
      const customer = (order.customer as { name?: string; phone?: string } | null) ?? {}
      const phone = sanitizePhone(customer.phone)
      if (!phone) return

      const storeName = await this.getStoreName(order.organization_id as string)

      // Checa se ganhou cashback nesse pedido (consulta movements pelo source_id)
      const { data: earnMv } = await supabaseAdmin
        .from('customer_cashback_movements')
        .select('amount_cents')
        .eq('source_id', orderId)
        .eq('type', 'earn')
        .maybeSingle()
      const earnedCents = earnMv ? Number((earnMv as { amount_cents: number }).amount_cents) : 0

      const lines = [
        `🎉 Olá, ${customer.name ?? 'cliente'}!`,
        ``,
        `Seu pedido da *${storeName}* foi entregue! Esperamos que você ame.`,
        ``,
        `Pedido *#${(order.id as string).slice(0, 8).toUpperCase()}*`,
      ]
      if (earnedCents > 0) {
        lines.push(``, `💰 Você ganhou *${formatBRL(earnedCents / 100)}* em cashback. Use no próximo pedido!`)
      }
      lines.push(``, `Que tal contar pra gente o que achou? Sua avaliação ajuda muito! 🙏`)

      await this.bridge.sendDirectMessage({
        organization_id: order.organization_id as string,
        phone,
        message:         lines.join('\n'),
        dedup_key:       `storefront_order:${orderId}:delivered`,
      })
    } catch (err) {
      this.logger.warn(`[notify.delivered] order=${orderId}: ${(err as Error).message}`)
    }
  }

  /** Dispara quando cliente sobe de tier no programa de fidelidade.
   *  Busca telefone via storefront_customers (email lookup).
   *  promotionId: id da row em loyalty_promotions (pra dedup). */
  async notifyTierPromotion(promotionId: string): Promise<void> {
    try {
      const { data: promo } = await supabaseAdmin
        .from('loyalty_promotions')
        .select('id, organization_id, customer_identifier, new_tier_id, notified_at')
        .eq('id', promotionId)
        .maybeSingle()
      if (!promo) return
      if ((promo as { notified_at?: string | null }).notified_at) return  // já notificado

      const { data: tier } = await supabaseAdmin
        .from('loyalty_tiers')
        .select('name, icon_emoji, benefits')
        .eq('id', (promo as { new_tier_id: string }).new_tier_id)
        .maybeSingle()
      if (!tier) return

      // Lookup phone via storefront_customers
      const { data: customer } = await supabaseAdmin
        .from('storefront_customers')
        .select('name, phone')
        .eq('organization_id', (promo as { organization_id: string }).organization_id)
        .eq('email', (promo as { customer_identifier: string }).customer_identifier)
        .maybeSingle()
      const phone = sanitizePhone((customer as { phone?: string } | null)?.phone)
      if (!phone) return

      const storeName = await this.getStoreName((promo as { organization_id: string }).organization_id)
      const tierName = (tier as { name: string }).name
      const emoji = (tier as { icon_emoji: string | null }).icon_emoji ?? '⭐'
      const benefits = (tier as { benefits?: Array<{ label: string }> }).benefits ?? []

      const lines = [
        `${emoji} Parabéns, ${(customer as { name?: string } | null)?.name ?? 'cliente'}!`,
        ``,
        `Você acabou de virar *${tierName}* na *${storeName}*!`,
      ]
      if (benefits.length > 0) {
        lines.push(``, `Seus novos benefícios:`)
        for (const b of benefits.slice(0, 5)) {
          lines.push(`✓ ${b.label}`)
        }
      }
      lines.push(``, `Continue comprando pra desbloquear ainda mais. 🚀`)

      const result = await this.bridge.sendDirectMessage({
        organization_id: (promo as { organization_id: string }).organization_id,
        phone,
        message:         lines.join('\n'),
        dedup_key:       `loyalty_promotion:${promotionId}`,
      })

      // Marca como notificado quando o bridge confirmou
      if (result.sent) {
        await supabaseAdmin
          .from('loyalty_promotions')
          .update({ notified_at: new Date().toISOString(), notification_channel: 'whatsapp' })
          .eq('id', promotionId)
      }
    } catch (err) {
      this.logger.warn(`[notify.tier] promotion=${promotionId}: ${(err as Error).message}`)
    }
  }

  private async getStoreName(orgId: string): Promise<string> {
    const { data } = await supabaseAdmin
      .from('store_config').select('store_name')
      .eq('organization_id', orgId).maybeSingle()
    return (data?.store_name as string) ?? 'nossa loja'
  }
}

/** Sanitiza telefone — remove tudo que não é número.
 *  Retorna string vazia (treat as no phone) se ficar muito curto. */
function sanitizePhone(raw?: string | null): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10) return ''
  return digits
}

const formatBRL = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
