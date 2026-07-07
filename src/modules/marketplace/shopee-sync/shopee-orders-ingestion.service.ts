import { Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { supabaseAdmin } from '../../../common/supabase'
import { computeContributionMargin, round2 } from '../../../common/margin'
import { MarketplaceService } from '../marketplace.service'
import { ShopeeAdapter } from '../adapters/shopee.adapter'
import type { MpConnection } from '../adapters/base'
import { ShopeeProductSyncService } from './shopee-product-sync.service'
import { parseShopeeLabelRecipient } from './shopee-label-parser.util'
import { ChannelSettingsService, ChannelFeeRule, estimateSaleFee } from '../../channel-settings/channel-settings.service'
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

    // take rate do canal shopee (org): achatado (fallback) + regras por faixa.
    const commissionPct = await this.channelSettings.getEstimatedTakeRatePct(orgId, 'shopee', 0)
    const feeRules = await this.channelSettings.getFeeRules(orgId, 'shopee')

    let lines = 0
    let failed = 0
    for (const od of details) {
      try {
        // Endereço via etiqueta: na janela "Organizar Envio"→despacho o
        // documento de envio expõe o endereço que o get_order_detail mascara.
        // Best-effort — enxerta no od antes do mirror (que persiste/preserva).
        await this.captureOpenRecipient(conn, od)
        lines += await this.mirrorOrder(orgId, od, commissionPct, shopId, feeRules)
      } catch (e: unknown) {
        failed++
        this.logger.warn(`[shopee.orders] pedido falhou: ${(e as Error)?.message}`)
      }
    }

    this.logger.log(`[shopee.orders] org=${orgId} shop=${shopId} orders=${details.length} lines=${lines} failed=${failed}`)
    return { shop_id: shopId, orders: details.length, lines, failed, from: from.toISOString(), to: to.toISOString() }
  }

  // Debounce do webhook: rajadas de push (status+rastreio+etiqueta do MESMO
  // pedido em segundos) viram 1 ingestão; janela curta pra não segurar
  // transição real de status.
  private readonly recentWebhookIngest = new Map<string, number>()
  private static readonly WEBHOOK_DEBOUNCE_MS = 20_000

  /** Ingestão de UM pedido em tempo real (chamada pelo webhook push).
   *  Mesmo pipeline do cron: detail → captureOpenRecipient (CPF/endereço na
   *  janela) → mirrorOrder (upsert + margem + estoque). Idempotente. */
  async ingestSingleOrder(orgId: string, shopId: number | string, orderSn: string): Promise<{
    ingested: boolean; reason?: string
  }> {
    const key = `${shopId}:${orderSn}`
    const last = this.recentWebhookIngest.get(key) ?? 0
    if (Date.now() - last < ShopeeOrdersIngestionService.WEBHOOK_DEBOUNCE_MS) {
      return { ingested: false, reason: 'debounce' }
    }
    this.recentWebhookIngest.set(key, Date.now())
    // GC simples do map (evita crescer pra sempre)
    if (this.recentWebhookIngest.size > 500) {
      const cutoff = Date.now() - ShopeeOrdersIngestionService.WEBHOOK_DEBOUNCE_MS
      for (const [k, t] of this.recentWebhookIngest) if (t < cutoff) this.recentWebhookIngest.delete(k)
    }

    const conns = await this.shopeeConnections(orgId)
    const baseConn = conns.find(c => String(c.shop_id) === String(shopId))
    if (!baseConn) return { ingested: false, reason: `loja ${shopId} não conectada na org` }
    const conn = await this.productSync.ensureFreshToken(baseConn)

    const details = await this.adapter.fetchOrderDetails(conn, [orderSn])
    if (!details.length) return { ingested: false, reason: 'detail vazio' }
    const od = details[0]

    const commissionPct = await this.channelSettings.getEstimatedTakeRatePct(orgId, 'shopee', 0)
    const feeRules = await this.channelSettings.getFeeRules(orgId, 'shopee')
    await this.captureOpenRecipient(conn, od)
    const lines = await this.mirrorOrder(orgId, od, commissionPct, Number(shopId), feeRules)
    this.logger.log(`[shopee.orders.push] pedido=${orderSn} shop=${shopId} linhas=${lines} (tempo real)`)
    // Sinal "venda nova" no Intelligence Hub (toast com valores/margem) —
    // paridade com o notifier do ML. Fire-and-forget: falha não afeta o ack.
    if (lines > 0) {
      void this.notifyNewSaleSignal(orgId, orderSn).catch(e =>
        this.logger.warn(`[shopee.new-sale] ${orderSn}: ${(e as Error)?.message ?? e}`))
    }
    return { ingested: lines > 0 }
  }

  /** Sinal `new_sale` pra venda Shopee — lê as linhas recém-gravadas em
   *  `orders` (margem/tarifa já calculadas) e insere em alert_signals com o
   *  MESMO shape do NewSaleNotifierService do ML (a UI de toasts/hub já
   *  entende). Guard de idempotência: 1 sinal por pedido (webhooks de
   *  status/rastreio/etiqueta chegam em sequência pro mesmo pedido).
   *  analyzer='ml' porque o CHECK de alert_signals ainda não tem valor por
   *  canal — a plataforma real vai em data.platform (refactor futuro). */
  private async notifyNewSaleSignal(orgId: string, orderSn: string): Promise<void> {
    const { data: existing } = await supabaseAdmin
      .from('alert_signals')
      .select('id')
      .eq('organization_id', orgId)
      .eq('category', 'new_sale')
      .eq('data->>order_id', orderSn)
      .limit(1)
    if (existing?.length) return

    const { data: rows } = await supabaseAdmin
      .from('orders')
      .select('product_id, product_title, sku, quantity, sale_price, cost_price, platform_fee, shipping_cost, tax_amount, contribution_margin, contribution_margin_pct, status, sold_at, channel_account_id')
      .eq('organization_id', orgId)
      .eq('source', 'shopee')
      .eq('external_order_id', orderSn)
    const lines = (rows ?? []) as Array<{
      product_id: string | null; product_title: string | null; sku: string | null
      quantity: number | null; sale_price: number | null; cost_price: number | null
      platform_fee: number | null; shipping_cost: number | null; tax_amount: number | null
      contribution_margin: number | null; contribution_margin_pct: number | null
      status: string | null; sold_at: string | null; channel_account_id: string | null
    }>
    if (!lines.length || lines[0].status === 'cancelled') return

    // agrega o pedido (sale_price Shopee JÁ é o total da linha)
    const total   = round2(lines.reduce((s, l) => s + (Number(l.sale_price) || 0), 0))
    const qty     = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)
    const tarifa  = round2(lines.reduce((s, l) => s + (Number(l.platform_fee) || 0), 0))
    const frete   = round2(lines.reduce((s, l) => s + (Number(l.shipping_cost) || 0), 0))
    const cost    = round2(lines.reduce((s, l) => s + (Number(l.cost_price) || 0), 0))
    const tax     = round2(lines.reduce((s, l) => s + (Number(l.tax_amount) || 0), 0))
    const hasMargin = lines.some(l => l.contribution_margin != null)
    const margemBrl = hasMargin
      ? round2(lines.reduce((s, l) => s + (Number(l.contribution_margin) || 0), 0))
      : round2(total - cost - tarifa - frete - tax)
    const margemPct = total > 0 ? round2(margemBrl / total * 100) : 0

    const first = lines[0]
    const title = String(first.product_title ?? '').trim() || `Venda ${orderSn}`
    const summary = qty > 1
      ? `Shopee: ${qty}× ${title} · R$ ${total.toFixed(2)} · margem ${margemPct.toFixed(1)}%`
      : `Shopee: ${title} · R$ ${total.toFixed(2)} · margem ${margemPct.toFixed(1)}%`
    const severity = margemPct < 10 ? 'warning' : 'info'
    const score = margemPct < 0 ? 75 : margemPct < 10 ? 55 : 25

    const { error } = await supabaseAdmin.from('alert_signals').insert({
      organization_id: orgId,
      analyzer:        'ml',
      category:        'new_sale',
      severity,
      score,
      entity_type:     'product',
      entity_id:       first.product_id ?? first.sku ?? orderSn,
      entity_name:     title,
      summary_pt:      summary,
      suggestion_pt:   hasMargin ? null : 'Venda sem custo cadastrado — vincule o anúncio a um produto com custo pra margem real.',
      status:          'new',
      data: {
        order_id: orderSn,
        platform: 'shopee',
        shop_id:  first.channel_account_id,
        sku:      first.sku ?? null,
        sold_at:  first.sold_at ?? null,
        values: {
          quantity: qty, total, cost, tarifa_ml: tarifa,
          frete_vendedor: frete, imposto: tax,
          margem_brl: margemBrl, margem_pct: margemPct,
        },
      },
      expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    if (error) throw new Error(error.message)
    this.logger.log(`[shopee.new-sale] sinal emitido pedido=${orderSn} total=R$${total} margem=${margemPct}%`)
  }

  /** Captura dados ABERTOS do comprador via documento de envio (etiqueta)
   *  quando o get_order_detail veio mascarado. Só tenta em pedido
   *  ready_to_ship com pacote; falha fora da janela = skip silencioso.
   *
   *  CPF: pra loja pessoa-física (ex.: Tudo em Casa) o detail mascara o
   *  buyer_cpf_id MESMO na janela — a etiqueta é a ÚNICA fonte aberta
   *  (validado ao vivo 2026-07-06). Enxerta em od.buyer_cpf_id → o mirror
   *  grava buyer_doc_number e o preserve impede re-sync mascarado de
   *  sobrescrever (fica gravado pro enriquecimento/clientes unificados). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async captureOpenRecipient(conn: MpConnection, od: any): Promise<void> {
    const masked = (v: unknown) => typeof v !== 'string' || !v.trim() || /^\*+$/.test(v.trim())
    if (this.mapShippingStatus(od?.order_status) !== 'ready_to_ship') return
    const r = od?.recipient_address
    let addressOpen = Boolean(r && !masked(r.full_address))
    let cpfOpen = !masked(od?.buyer_cpf_id)

    // já capturado num sync anterior? reusa do banco (evita re-baixar a
    // etiqueta a cada ciclo do cron enquanto o pedido está na janela)
    if (!addressOpen || !cpfOpen) {
      const { data: prev } = await supabaseAdmin
        .from('orders')
        .select('buyer_doc_number, raw_data')
        .eq('source', 'shopee')
        .eq('external_order_id', String(od.order_sn))
        .limit(1)
      const prevRow = (prev ?? [])[0] as { buyer_doc_number: string | null; raw_data: Record<string, unknown> | null } | undefined
      const prevRcpt = prevRow?.raw_data?.recipient_address as Record<string, unknown> | undefined
      if (!addressOpen && prevRcpt && !masked(prevRcpt.full_address)) {
        od.recipient_address = prevRcpt
        addressOpen = true
      }
      if (!cpfOpen && prevRow?.buyer_doc_number) {
        od.buyer_cpf_id = prevRow.buyer_doc_number
        cpfOpen = true
      }
    }
    if (addressOpen && cpfOpen) return  // nada a capturar

    const pkg = od?.package_list?.[0]?.package_number
    if (!pkg) return
    try {
      const open = await this.adapter.fetchShippingDocumentRecipient(conn, String(od.order_sn), String(pkg))
      if (!cpfOpen && open.buyer_cpf_id) {
        od.buyer_cpf_id = open.buyer_cpf_id
        this.logger.log(`[shopee.orders] CPF capturado via etiqueta: ${od.order_sn}`)
      }
      if (!addressOpen && open.recipient && !masked(open.recipient.full_address ?? open.recipient.address)) {
        od.recipient_address = { ...(r ?? {}), ...open.recipient }
        addressOpen = true
        this.logger.log(`[shopee.orders] endereço capturado via etiqueta (data_info): ${od.order_sn}`)
      }
      // Fallback final: o PDF da etiqueta carrega NOME+ENDEREÇO abertos com
      // camada de texto (recipient_address_info da API vem null no SPX BR).
      if (!addressOpen) {
        const pdf = await this.adapter.downloadShippingDocumentPdf(conn, String(od.order_sn), String(pkg))
        const rec = pdf ? await parseShopeeLabelRecipient(pdf, String(od.order_sn)) : null
        if (rec) {
          od.recipient_address = { ...(r ?? {}), ...rec }
          this.logger.log(`[shopee.orders] nome+endereço capturados via PDF da etiqueta: ${od.order_sn}`)
        }
      }
    } catch (e: unknown) {
      // fora da janela (não organizado/já despachado) — esperado na maioria
      this.logger.debug(`[shopee.orders] etiqueta ${od?.order_sn}: ${(e as Error)?.message}`)
    }
  }

  /** Mapeia 1 pedido Shopee (detail com item_list) → N linhas em orders (1/SKU).
   *  `shopId` carimba a conta no pedido (channel_account_id) pro dropship
   *  distinguir multi-loja. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async mirrorOrder(orgId: string, od: any, commissionPct: number, shopId: number, feeRules: ChannelFeeRule[] = []): Promise<number> {
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
    // A Shopee só expõe dados do comprador (CPF/endereço/fone) DURANTE a
    // preparação do pedido (READY_TO_SHIP) — é a janela da NF-e/etiqueta.
    // Depois de despachado, a API devolve tudo MASCARADO ("****"). Por isso:
    // (1) capturamos os dados ABERTOS quando o cron pega o pedido na janela;
    // (2) NUNCA sobrescrevemos um valor capturado com a versão mascarada do
    //     re-sync seguinte (preserva do row existente).
    const unmasked = (v: unknown): string | null => {
      const s = typeof v === 'string' ? v.trim() : ''
      return s && !/^\*+$/.test(s) ? s : null
    }

    // valores já capturados em syncs anteriores (janela aberta) + linhas cuja
    // tarifa REAL (escrow) já reconciliou — essas o re-sync NÃO pode regredir
    // pra estimativa.
    const { data: prevRows } = await supabaseAdmin
      .from('orders')
      .select('sku, platform_fee_source, buyer_doc_number, buyer_phone, buyer_name, raw_data')
      .eq('source', 'shopee')
      .eq('external_order_id', String(od?.order_sn))
    const prevRow = (prevRows ?? [])[0] as { buyer_doc_number: string | null; buyer_phone: string | null; buyer_name: string | null; raw_data: Record<string, unknown> | null } | undefined
    const escrowLockedSkus = new Set(
      ((prevRows ?? []) as Array<{ sku: string | null; platform_fee_source: string | null }>)
        .filter(r => r.platform_fee_source === 'escrow')
        .map(r => String(r.sku)),
    )

    const buyerOpen = unmasked(rcpt?.name)
    const buyer = buyerOpen
      ?? (unmasked(prevRow?.buyer_name) && prevRow!.buyer_name !== unmasked(od?.buyer_username) ? prevRow!.buyer_name : null)
      ?? unmasked(od?.buyer_username)
      ?? null
    const phone = (unmasked(rcpt?.phone) ? String(rcpt!.phone).replace(/\D/g, '') || null : null)
      ?? prevRow?.buyer_phone ?? null
    const cpf = (unmasked(od?.buyer_cpf_id) ? String(od!.buyer_cpf_id).replace(/\D/g, '') || null : null)
      ?? prevRow?.buyer_doc_number ?? null
    const buyerUsername = unmasked(od?.buyer_username)

    // raw_data: se o detalhe novo veio mascarado mas o raw anterior tem o
    // endereço/CPF abertos, preserva os campos abertos no raw armazenado
    // (o card lê o endereço de entrega do raw).
    let rawToStore: Record<string, unknown> = od as Record<string, unknown>
    const prevRaw = prevRow?.raw_data
    if (prevRaw) {
      const prevRcpt = prevRaw.recipient_address as Record<string, unknown> | undefined
      const newMasked = !unmasked(rcpt?.full_address)
      const prevOpen  = !!(prevRcpt && unmasked(prevRcpt.full_address))
      rawToStore = {
        ...od,
        recipient_address: newMasked && prevOpen ? prevRcpt : od?.recipient_address,
        buyer_cpf_id: unmasked(od?.buyer_cpf_id) ?? unmasked(prevRaw.buyer_cpf_id) ?? od?.buyer_cpf_id,
        // mediations é enxertado pelo sync de devoluções (returns API) — o
        // detail do pedido não traz isso, então preserva no re-sync.
        ...(Array.isArray(prevRaw.mediations) && prevRaw.mediations.length
          ? { mediations: prevRaw.mediations }
          : {}),
      }
    }
    const nowIso = new Date().toISOString()

    let n = 0
    for (const g of groups.values()) {
      const link = linkByItemId.get(g.item_id) ?? null
      const sale_price = round2(g.sale_total)
      // Tarifa Shopee (tabela mar/2026) = % + FIXA por unidade. A faixa é pelo
      // preço UNITÁRIO (não pelo total da linha); a fixa multiplica a qtd.
      // Sem regra configurada → % achatado da org (fallback).
      const unitPrice = g.qty > 0 ? sale_price / g.qty : sale_price
      const platform_fee = estimateSaleFee(feeRules, unitPrice, g.qty, commissionPct)
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

      // linha já reconciliada com o escrow REAL → não regride pra estimativa
      const locked = escrowLockedSkus.has(g.sku)
      const feeFields = locked ? {} : {
        platform_fee,
        gross_profit,
        tax_amount,
        contribution_margin,
        contribution_margin_pct,
        platform_fee_source: 'estimated',
      }
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
          ...feeFields,
          shipping_cost,
          cost_price,
          status,
          shipping_status:    this.mapShippingStatus(od?.order_status),
          channel_account_id: String(shopId),  // carimbo da loja (multi-loja dropship)
          marketplace_listing_id: g.item_id || null,  // vínculo na tela de pedidos
          buyer_name:        buyer,
          buyer_username:    buyerUsername,
          buyer_phone:       phone,
          buyer_doc_number:  cpf,
          sold_at:           soldAt,
          raw_data:          rawToStore,
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
