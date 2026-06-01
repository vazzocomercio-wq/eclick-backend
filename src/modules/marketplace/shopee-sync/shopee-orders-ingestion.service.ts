import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../../common/supabase'
import { computeContributionMargin, round2 } from '../../../common/margin'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ChannelSettingsService } from '../../channel-settings/channel-settings.service'

/** F18 F1.6 — Ingestão de pedidos Shopee na tabela unificada `public.orders`.
 *
 *  Espelha o mirror do TikTok Shop (plataforma não-ML → orders): listOrders →
 *  get_order_detail (com item_list) → 1 linha por SKU vendido. Upsert por
 *  (source, external_order_id, sku). **Escreve SÓ source/platform='shopee' —
 *  NÃO toca em nenhuma linha do ML.** Idempotente (re-sync sobrescreve).
 *
 *  Valores monetários da Shopee são BRL cheios (sem /100). Margem só é
 *  computada quando o anúncio está vinculado a um produto (product_listings
 *  platform='shopee') — senão product_id/cost/margin ficam null (a tela
 *  mostra o pedido com receita/comprador/status mesmo assim). */
@Injectable()
export class ShopeeOrdersIngestionService {
  private readonly logger = new Logger(ShopeeOrdersIngestionService.name)
  private static readonly DEFAULT_DAYS = 60

  constructor(
    private readonly mp:              MarketplaceService,
    private readonly adapter:         ShopeeAdapter,
    private readonly productSync:     ShopeeProductSyncService,
    private readonly channelSettings: ChannelSettingsService,
  ) {}

  async syncOrders(orgId: string, days = ShopeeOrdersIngestionService.DEFAULT_DAYS): Promise<{
    shop_id: number
    orders:  number
    lines:   number
    failed:  number
    from:    string
    to:      string
  }> {
    const resolved = await this.mp.resolve(orgId, 'shopee')
    if (!resolved) throw new NotFoundException('Loja Shopee não conectada nesta organização')
    const conn = await this.productSync.ensureFreshToken(resolved.conn)
    if (!conn.shop_id) throw new NotFoundException('Conexão Shopee sem shop_id')
    const shopId = conn.shop_id

    const to   = new Date()
    const from = new Date(Date.now() - days * 86400_000)

    const summaries = await this.adapter.listOrders(conn, { from, to })
    const sns = summaries.map(s => s.external_order_id).filter(Boolean)
    const details = await this.adapter.fetchOrderDetails(conn, sns)

    // comissão do canal shopee (org) — fallback 0 se não configurado.
    const commissionPct = await this.channelSettings.getCommissionPct(orgId, 'shopee', 0)

    let lines = 0
    let failed = 0
    for (const od of details) {
      try {
        lines += await this.mirrorOrder(orgId, od, commissionPct)
      } catch (e: unknown) {
        failed++
        this.logger.warn(`[shopee.orders] pedido falhou: ${(e as Error)?.message}`)
      }
    }

    this.logger.log(`[shopee.orders] org=${orgId} shop=${shopId} orders=${details.length} lines=${lines} failed=${failed}`)
    return { shop_id: shopId, orders: details.length, lines, failed, from: from.toISOString(), to: to.toISOString() }
  }

  /** Mapeia 1 pedido Shopee (detail com item_list) → N linhas em orders (1/SKU). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mirrorOrder(orgId: string, od: any, commissionPct: number): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(od?.item_list) ? od.item_list : []
    if (!items.length) return 0

    type Group = { sku: string; item_id: string; product_title: string; qty: number; sale_total: number }
    const groups = new Map<string, Group>()
    for (const it of items) {
      const sku = String(it?.model_sku ?? '').trim() || String(it?.item_sku ?? '').trim() || String(it?.item_id ?? '')
      if (!sku) continue
      const qty  = Number(it?.model_quantity_purchased) || 0
      const unit = Number(it?.model_discounted_price) || 0
      const g = groups.get(sku) ?? {
        sku, item_id: String(it?.item_id ?? ''),
        product_title: it?.item_name ?? '(produto)', qty: 0, sale_total: 0,
      }
      g.qty += qty
      g.sale_total += unit * qty
      groups.set(sku, g)
    }
    if (!groups.size) return 0

    // Vínculo produto (custo/imposto) por item_id Shopee — vazio até linkar.
    const linkByItemId = new Map<string, { product_id: string; cost_price: number | null; tax_pct: number; tax_on_freight: boolean }>()
    const itemIds = [...groups.values()].map(g => g.item_id).filter(Boolean)
    if (itemIds.length) {
      const { data } = await supabaseAdmin
        .from('product_listings')
        .select('listing_id, product_id, products(cost_price, tax_percentage, tax_on_freight)')
        .eq('platform', 'shopee')
        .eq('is_active', true)
        .in('listing_id', itemIds)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const r of (data ?? []) as any[]) {
        const prod = r.products
        linkByItemId.set(String(r.listing_id), {
          product_id:     r.product_id,
          cost_price:     prod?.cost_price ?? null,
          tax_pct:        Number(prod?.tax_percentage ?? 0) || 0,
          tax_on_freight: Boolean(prod?.tax_on_freight),
        })
      }
    }

    const subTotalAll = [...groups.values()].reduce((s, g) => s + g.sale_total, 0)
    const shippingFee = Number(od?.actual_shipping_fee ?? 0) || 0
    const status = this.mapStatus(od?.order_status)
    const soldAt = od?.create_time ? new Date(od.create_time * 1000).toISOString() : null
    const rcpt = od?.recipient_address ?? null
    const buyer = rcpt?.name ?? od?.buyer_username ?? null
    const phone = rcpt?.phone ? String(rcpt.phone).replace(/\D/g, '') || null : null
    const cpf = od?.buyer_cpf_id ? String(od.buyer_cpf_id).replace(/\D/g, '') || null : null
    const nowIso = new Date().toISOString()

    let n = 0
    for (const g of groups.values()) {
      const link = linkByItemId.get(g.item_id) ?? null
      const sale_price = round2(g.sale_total)
      const platform_fee = round2(sale_price * commissionPct / 100)
      const shipping_cost = subTotalAll > 0 ? round2(shippingFee * sale_price / subTotalAll) : 0
      const cost_price = link?.cost_price != null ? round2(Number(link.cost_price) * g.qty) : null

      let tax_amount: number | null = null
      let contribution_margin: number | null = null
      let contribution_margin_pct: number | null = null
      if (cost_price != null) {
        const m = computeContributionMargin({
          price: sale_price, saleFee: platform_fee, shipping: shipping_cost,
          cost: cost_price, taxPercentage: link?.tax_pct ?? 0, taxOnFreight: link?.tax_on_freight ?? false,
        })
        tax_amount = m.taxAmount
        contribution_margin = m.contributionMargin
        contribution_margin_pct = m.contributionMarginPct
      }
      const gross_profit = round2(sale_price - platform_fee - shipping_cost)

      const { error } = await supabaseAdmin.from('orders').upsert(
        {
          organization_id:   orgId,
          source:            'shopee',
          platform:          'shopee',
          external_order_id: String(od?.order_sn),
          sku:               g.sku,
          product_id:        link?.product_id ?? null,
          product_title:     g.product_title,
          quantity:          g.qty,
          sale_price,
          platform_fee,
          shipping_cost,
          cost_price,
          tax_amount,
          gross_profit,
          contribution_margin,
          contribution_margin_pct,
          status,
          buyer_name:        buyer,
          buyer_phone:       phone,
          buyer_doc_number:  cpf,
          sold_at:           soldAt,
          raw_data:          od as Record<string, unknown>,
          updated_at:        nowIso,
        },
        { onConflict: 'source,external_order_id,sku' },
      )
      if (error) this.logger.warn(`[shopee.orders] sku=${g.sku} pedido=${od?.order_sn}: ${error.message}`)
      else n++
    }
    return n
  }

  /** Shopee order_status → status interno (mesmo vocabulário do TikTok mirror). */
  private mapStatus(s?: string): string {
    switch ((s ?? '').toUpperCase()) {
      case 'UNPAID':            return 'pending'
      case 'READY_TO_SHIP':
      case 'PROCESSED':
      case 'RETRY_SHIP':        return 'paid'
      case 'SHIPPED':
      case 'TO_CONFIRM_RECEIVE': return 'shipped'
      case 'COMPLETED':         return 'delivered'
      case 'IN_CANCEL':
      case 'CANCELLED':
      case 'TO_RETURN':         return 'cancelled'
      default:                  return 'pending'
    }
  }
}
