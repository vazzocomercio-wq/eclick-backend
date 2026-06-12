import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { computeContributionMargin, round2 } from '../../../common/margin'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import type { MpConnection } from '../adapters/base'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { ChannelSettingsService } from '../../channel-settings/channel-settings.service'
import { StockService } from '../../stock/stock.service'

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

  // forwardRef: StockModule importa MarketplaceModule (propagação estoque →
  // anúncio Shopee) e vice-versa (venda Shopee → baixa estoque mestre aqui).
  constructor(
    private readonly mp:              MarketplaceService,
    private readonly adapter:         ShopeeAdapter,
    private readonly productSync:     ShopeeProductSyncService,
    private readonly channelSettings: ChannelSettingsService,
    @Inject(forwardRef(() => StockService))
    private readonly stockService:    StockService,
  ) {}

  private static readonly CRON_DAYS = 3

  /** Cron horário — sincroniza janela curta de TODAS as orgs com loja Shopee.
   *  Gated por env SHOPEE_ORDER_SYNC='on' (controle de rollout). */
  @Cron('0 */1 * * *', { name: 'shopee-orders-sync' })
  async syncTick(): Promise<void> {
    if (process.env.SHOPEE_ORDER_SYNC !== 'on') return
    const { data: rows } = await supabaseAdmin
      .from('marketplace_connections')
      .select('organization_id')
      .eq('platform', 'shopee')
      .eq('status', 'connected')
    const orgIds = [...new Set((rows ?? []).map(r => r.organization_id as string))]
    for (const orgId of orgIds) {
      try {
        await this.syncOrders(orgId, ShopeeOrdersIngestionService.CRON_DAYS)
      } catch (e) {
        this.logger.warn(`[shopee.orders.cron] org=${orgId}: ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  /** Lista as conexões Shopee da org (multi-loja). */
  private async shopeeConnections(orgId: string): Promise<MpConnection[]> {
    return (await this.mp.listConnections(orgId)).filter(c => c.platform === 'shopee')
  }

  /** Sincroniza TODAS as lojas Shopee da org (multi-loja). Retorna 1 resumo por loja. */
  async syncOrders(orgId: string, days = ShopeeOrdersIngestionService.DEFAULT_DAYS): Promise<Array<{
    shop_id: number | null
    orders?:  number
    lines?:   number
    failed?:  number
    from?:    string
    to?:      string
    error?:   string
  }>> {
    const conns = await this.shopeeConnections(orgId)
    if (conns.length === 0) throw new NotFoundException('Nenhuma loja Shopee conectada nesta organização')
    const out = []
    for (const c of conns) {
      try {
        out.push(await this.syncShop(orgId, c, days))
      } catch (e) {
        this.logger.warn(`[shopee.orders] shop=${c.shop_id} falhou: ${e instanceof Error ? e.message : e}`)
        out.push({ shop_id: c.shop_id ?? null, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return out
  }

  /** Sincroniza UMA loja Shopee → orders. */
  private async syncShop(orgId: string, baseConn: MpConnection, days: number): Promise<{
    shop_id: number; orders: number; lines: number; failed: number; from: string; to: string
  }> {
    const conn = await this.productSync.ensureFreshToken(baseConn)
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
        lines += await this.mirrorOrder(orgId, od, commissionPct, shopId)
      } catch (e: unknown) {
        failed++
        this.logger.warn(`[shopee.orders] pedido falhou: ${(e as Error)?.message}`)
      }
    }

    this.logger.log(`[shopee.orders] org=${orgId} shop=${shopId} orders=${details.length} lines=${lines} failed=${failed}`)
    return { shop_id: shopId, orders: details.length, lines, failed, from: from.toISOString(), to: to.toISOString() }
  }

  /** Mapeia 1 pedido Shopee (detail com item_list) → N linhas em orders (1/SKU).
   *  `shopId` carimba a conta no pedido (channel_account_id) pro dropship
   *  distinguir multi-loja. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mirrorOrder(orgId: string, od: any, commissionPct: number, shopId: number): Promise<number> {
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
    // A Shopee MASCARA dados sensíveis ("****") quando o app não tem o acesso
    // "Sensitive Data" — campo mascarado vira null e cai pro buyer_username
    // (sempre aberto), que identifica o comprador na tela e no CRM.
    const unmasked = (v: unknown): string | null => {
      const s = typeof v === 'string' ? v.trim() : ''
      return s && !/^\*+$/.test(s) ? s : null
    }
    const buyer = unmasked(rcpt?.name) ?? unmasked(od?.buyer_username) ?? null
    const phone = unmasked(rcpt?.phone) ? String(rcpt!.phone).replace(/\D/g, '') || null : null
    const cpf = unmasked(od?.buyer_cpf_id) ? String(od!.buyer_cpf_id).replace(/\D/g, '') || null : null
    const buyerUsername = unmasked(od?.buyer_username)
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
          shipping_status:    this.mapShippingStatus(od?.order_status),
          channel_account_id: String(shopId),  // carimbo da loja (multi-loja dropship)
          buyer_name:        buyer,
          buyer_username:    buyerUsername,
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

    // Baixa de estoque (Estoque Unificado): venda paga/enviada/entregue baixa o
    // ledger, cancelamento estorna — paridade com ML/TikTok. Idempotente
    // (apply_sale_movement_tx), então o re-sync da janela é seguro. Best-effort:
    // falha na baixa não derruba o espelho do pedido.
    await this.applyOrderStockMovement(orgId, od, shopId, status).catch(e =>
      this.logger.warn(`[shopee.stock] pedido=${od?.order_sn}: ${e instanceof Error ? e.message : e}`))

    return n
  }

  /** Gate da baixa de estoque: env SHOPEE_ORDER_DECREMENT define a data de corte
   *  ('on' = corte default abaixo; ou um ISO date explícito, ex '2026-06-11').
   *  Pedidos CRIADOS antes do corte nunca mexem no estoque — o sync re-varre a
   *  janela inteira (até 60d) e sem o corte o primeiro deploy baixaria
   *  retroativamente todo o histórico já ingerido. Ausente/inválida = OFF. */
  private static readonly STOCK_DEFAULT_CUTOFF = '2026-06-11T00:00:00-03:00'
  private stockCutoffMs(): number | null {
    const v = (process.env.SHOPEE_ORDER_DECREMENT ?? '').trim()
    if (!v) return null
    const t = Date.parse(v.toLowerCase() === 'on' ? ShopeeOrdersIngestionService.STOCK_DEFAULT_CUTOFF : v)
    return Number.isFinite(t) ? t : null
  }

  /** Baixa o estoque mestre a partir das linhas do pedido Shopee. Resolve o
   *  produto via product_listings (platform='shopee', account_id=shop_id,
   *  listing_id=item_id; variação exata primeiro, fallback vínculo de item
   *  variation_id=''), agrega por produto e chama applySaleMovement
   *  (idempotente; composição/kit baixa componentes; recalc re-propaga pros
   *  canais). Cancelamento estorna. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async applyOrderStockMovement(orgId: string, od: any, shopId: number, status: string): Promise<void> {
    const cutoff = this.stockCutoffMs()
    if (cutoff == null) return                                      // gate OFF
    const createdMs = (Number(od?.create_time) || 0) * 1000
    if (createdMs < cutoff) return                                  // pedido antigo — não tocar
    if (status === 'pending') return                                // não pago ainda

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const items: any[] = Array.isArray(od?.item_list) ? od.item_list : []
    type Line = { itemId: string; varId: string; qty: number }
    const lines: Line[] = []
    for (const it of items) {
      const itemId = String(it?.item_id ?? '')
      if (!itemId) continue
      const qty = Number(it?.model_quantity_purchased) || 0
      if (qty <= 0) continue
      // model_id=0 = item sem variação → vínculo nível-item (variation_id '')
      const varId = it?.model_id ? String(it.model_id) : ''
      lines.push({ itemId, varId, qty })
    }
    if (!lines.length) return

    const { data: links } = await supabaseAdmin
      .from('product_listings')
      .select('listing_id, variation_id, product_id')
      .eq('platform', 'shopee')
      .eq('account_id', String(shopId))
      .eq('is_active', true)
      .in('listing_id', [...new Set(lines.map(l => l.itemId))])
    if (!links?.length) return
    const linkRows = links as Array<{ listing_id: string; variation_id: string | null; product_id: string }>

    // por linha: vínculo da variação exata > vínculo nível-item ('')
    const qtyByProduct = new Map<string, number>()
    for (const l of lines) {
      const candidates = linkRows.filter(r => String(r.listing_id) === l.itemId)
      const match = candidates.find(r => (r.variation_id ?? '') === l.varId)
        ?? candidates.find(r => (r.variation_id ?? '') === '')
      if (!match?.product_id) continue
      qtyByProduct.set(match.product_id, (qtyByProduct.get(match.product_id) ?? 0) + l.qty)
    }

    for (const [productId, quantity] of qtyByProduct) {
      const r = await this.stockService.applySaleMovement({
        productId,
        quantity,
        externalOrderId: String(od?.order_sn),
        status,
        channel: 'shopee',
      })
      if (r !== 'noop') this.logger.log(
        `[shopee.stock] pedido=${od?.order_sn} produto=${productId} qty=${quantity} status=${status} → ${r}`)
    }
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

  /** Shopee order_status → shipping_status canônico (vocabulário do funil
   *  dropship: ready_to_ship NÃO entra em OC; shipped/delivered sim). */
  private mapShippingStatus(s?: string): string | null {
    switch ((s ?? '').toUpperCase()) {
      case 'READY_TO_SHIP':
      case 'PROCESSED':
      case 'RETRY_SHIP':         return 'ready_to_ship'  // etiqueta gerada, NÃO postado
      case 'SHIPPED':
      case 'TO_CONFIRM_RECEIVE': return 'shipped'
      case 'COMPLETED':          return 'delivered'
      case 'IN_CANCEL':
      case 'CANCELLED':
      case 'TO_RETURN':          return 'cancelled'
      default:                   return null            // UNPAID etc → sem envio
    }
  }
}
