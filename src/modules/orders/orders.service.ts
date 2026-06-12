import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'
import { computeContributionMargin, estimateSaleFee, round2 } from '../../common/margin'

const ML_BASE = 'https://api.mercadolibre.com'

export interface CreateManualOrderDto {
  platform: string
  product_title: string
  sku?: string
  quantity: number
  sale_price: number
  cost_price?: number
  buyer_name: string
  buyer_phone?: string
  shipping_address?: string
  payment_method: string
  notes?: string
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name)

  constructor(private readonly ml: MercadolivreService) {}

  async createManualOrder(orgId: string, dto: CreateManualOrderDto) {
    // Pedido manual não tem tarifa real do ML — estima 11,5% (sem categoria
    // não dá pra precisar). Vendas reais ingeridas via webhook usam o
    // `sale_fee` real. Frete e imposto não são resolvidos no manual.
    const platformFee  = dto.platform === 'ml' ? estimateSaleFee(dto.sale_price, 11.5, 0) : 0
    const shippingCost = 0
    const grossProfit  = round2(dto.sale_price - platformFee - shippingCost)
    const margin = computeContributionMargin({
      price:         dto.sale_price,
      saleFee:       platformFee,
      shipping:      shippingCost,
      cost:          dto.cost_price ?? 0,
      taxPercentage: 0,
      taxOnFreight:  false,
    })

    const { data, error } = await supabaseAdmin
      .from('orders')
      .insert({
        source:                 'manual',
        platform:               dto.platform,
        buyer_name:             dto.buyer_name,
        product_title:          dto.product_title,
        sku:                    dto.sku ?? null,
        quantity:               dto.quantity,
        sale_price:             dto.sale_price,
        cost_price:             dto.cost_price ?? null,
        platform_fee:           platformFee,
        shipping_cost:          shippingCost,
        gross_profit:           grossProfit,
        contribution_margin:    margin.contributionMargin,
        contribution_margin_pct: margin.contributionMarginPct,
        status:                 'pending',
        notes:                  dto.notes ?? null,
      })
      .select('id')
      .single()

    if (error) throw new Error(error.message)
    return { id: data.id }
  }

  async getManualOrders(orgId: string, offset = 0, limit = 20) {
    const { data, error, count } = await supabaseAdmin
      .from('orders')
      .select('*', { count: 'exact' })
      .eq('source', 'manual')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw new Error(error.message)
    return { orders: data ?? [], total: count ?? 0 }
  }

  /** Lista pedidos do DB (snapshot do sales-aggregator) com filtros server-side
   *  por tab pra resolver paginação correta.
   *
   *  Mapeia tab → condições SQL combinadas (espelha lógica de classifyOrder
   *  no frontend mas em SQL). Retorna shape compatível com /ml/orders/enriched.
   */
  async listOrders(
    orgId: string | null,
    options: {
      offset?:     number
      limit?:      number
      q?:          string
      seller_id?:  number
      tab?:       'abertas' | 'em_preparacao' | 'despachadas' | 'pgto_pendente' | 'flex' | 'encerradas' | 'mediacao' | 'canceladas'
      platform?:  'mercadolivre' | 'manual' | 'tiktok_shop' | 'shopee' | 'storefront' | 'all'
      account_id?: string
    } = {},
  ) {
    const offset = Math.max(options.offset ?? 0, 0)
    const limit  = Math.min(options.limit  ?? 20, 200)

    // Pedidos da Loja Própria moram em storefront_orders — schema diferente.
    // Quando o user filtra explicitamente "storefront", redireciona pra
    // listStorefrontOrders que mapeia pro shape canônico. Tabs marketplace
    // não fazem sentido aqui (pending/paid em vez de shipping_status).
    if (options.platform === 'storefront') {
      return this.listStorefrontOrders(orgId, { offset, limit, q: options.q })
    }

    let q = supabaseAdmin
      .from('orders')
      .select('*', { count: 'exact' })
      .order('sold_at', { ascending: false })

    if (orgId)              q = q.eq('organization_id', orgId)
    if (options.seller_id)  q = q.eq('seller_id',       options.seller_id)
    // Filtro por loja do canal (shop_id Shopee/TikTok carimbado no pedido)
    if (options.account_id) q = q.eq('channel_account_id', options.account_id)

    // Filtro de source: específico ou todos os canais do `orders`.
    if (options.platform === 'mercadolivre') {
      q = q.eq('source', 'mercadolivre')
    } else if (options.platform === 'manual') {
      q = q.eq('source', 'manual')
    } else if (options.platform === 'tiktok_shop') {
      q = q.eq('source', 'tiktok_shop')
    } else if (options.platform === 'shopee') {
      q = q.eq('source', 'shopee')
    } else {
      q = q.in('source', ['mercadolivre', 'manual', 'tiktok_shop', 'shopee'])
    }

    // Filtro de busca: matcheia external_order_id, sku ou buyer_name
    const search = options.q?.trim()
    if (search) {
      const esc = search.replace(/[%]/g, '')
      q = q.or(
        `external_order_id.ilike.%${esc}%,sku.ilike.%${esc}%,buyer_name.ilike.%${esc}%,product_title.ilike.%${esc}%`,
      )
    }

    // Filtro por tab — espelha classifyOrder() do frontend, em SQL.
    // NOTA: shipping_status pode ser NULL pra muitos pedidos (worker antigo
    // não populava). Filtros tratam NULL como "ativo / aberto" — mesmo
    // comportamento de pedidos só com status='paid' sem detalhe de envio.
    if (options.tab) {
      switch (options.tab) {
        case 'mediacao':
          // raw_data->mediations array com elementos OU raw_data->tags incluindo 'mediation_in_progress'
          q = q.or(
            `raw_data->mediations.cs.[{}],raw_data->tags.cs.["mediation_in_progress"]`,
          )
          break
        case 'pgto_pendente':
          q = q.in('status', ['payment_required', 'payment_in_process'])
          break
        case 'encerradas':
          // status=cancelled OU shipping_status in (delivered, not_delivered)
          q = q.or('status.eq.cancelled,shipping_status.in.(delivered,not_delivered)')
          break
        case 'canceladas':
          // Filtro independente — pedido com mediação + cancelled aparece
          // aqui E em 'mediacao'. Comportamento desejado (opção C escolhida
          // pelo user — visibilidade dupla pra ações de auditoria/dispute).
          q = q.eq('status', 'cancelled')
          break
        case 'flex':
          // Flex precisa de logistic_type — se worker não populou, ninguém aparece
          q = q.eq('raw_data->shipping->>logistic_type', 'self_service')
          q = q.neq('status', 'cancelled')
          break
        case 'despachadas':
          // Só funciona quando worker popular shipping_status
          q = q.in('shipping_status', ['shipped', 'in_transit'])
          q = q.neq('status', 'cancelled')
          break
        case 'em_preparacao':
          q = q.in('shipping_status', ['handling', 'ready_to_ship'])
          q = q.neq('status', 'cancelled')
          break
        case 'abertas':
          // Pedido ativo: status='paid' (ou sem cancelled/payment), e sem
          // shipping_status terminal. NULL conta como aberto.
          q = q.not('status', 'in', '(cancelled,payment_required,payment_in_process)')
          q = q.or('shipping_status.is.null,shipping_status.in.(pending,not_specified)')
          break
      }
    }

    q = q.range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)

    // Mapeia rows do DB pro shape consumido pelo PedidosTable / OrderCard
    // (espelha o que /ml/orders/enriched retornava).
    const orders = (data ?? []).map(row => mapRowToFrontend(row as DbOrderRow))

    // Enriquecimento on-demand pra preencher dados que o worker antigo não
    // salvava (thumbnail, payments, shipping detalhado). Roda APENAS na
    // página retornada (≤200 orders), com fan-out cross-conta.
    if (orgId && orders.length > 0) {
      try {
        await this.enrichOrdersForUI(orgId, orders, options.seller_id)
      } catch (err) {
        this.logger.warn(`[orders.list.enrich] falhou — seguindo sem enrich: ${(err as Error).message}`)
      }
      // Identificação de canal/loja (nome da conta) + thumbnail via produto
      // vinculado pros canais sem enrich de item (Shopee/TikTok/manual).
      try {
        await this.decorateChannelOrders(orgId, orders)
      } catch (err) {
        this.logger.warn(`[orders.list.decorate] falhou — seguindo sem decorate: ${(err as Error).message}`)
      }
    }

    return { orders, total: count ?? 0 }
  }

  /** Decora a página de pedidos com: (a) `account_label` — nome da conta/loja
   *  do pedido (nickname ML por seller_id; nome da loja Shopee/TikTok por
   *  channel_account_id); (b) thumbnail do produto vinculado quando o canal
   *  não tem enrich de item (Shopee/TikTok/manual). Best-effort, nunca lança. */
  private async decorateChannelOrders(
    orgId: string,
    orders: Array<Record<string, unknown>>,
  ): Promise<void> {
    const nick = await this.ordersBuildNicknameMap(orgId)

    // thumbnails: pedidos não-ML sem thumbnail mas com produto vinculado
    const needThumb = orders.filter(o => {
      const src = o.source as string | null
      if (src === 'mercadolivre') return false
      const items = o.order_items as Array<{ thumbnail?: string | null }> | undefined
      return !!(o as { product_id?: string | null }).product_id && !!items?.length && !items[0].thumbnail
    })
    const productIds = [...new Set(needThumb.map(o => (o as { product_id?: string }).product_id!))]
    const thumbByProduct = new Map<string, string>()
    if (productIds.length > 0) {
      const { data } = await supabaseAdmin
        .from('products')
        .select('id, photo_urls, images')
        .in('id', productIds.slice(0, 200))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (data ?? []) as any[]) {
        const url = (Array.isArray(p.photo_urls) && p.photo_urls[0])
          || (Array.isArray(p.images) && (p.images[0]?.url ?? p.images[0]))
          || null
        if (typeof url === 'string' && url) thumbByProduct.set(p.id, url)
      }
    }

    for (const o of orders) {
      const src       = (o.source as string | null) ?? null
      const sellerId  = (o as { seller_id?: number | null }).seller_id ?? null
      const accountId = (o as { channel_account_id?: string | null }).channel_account_id ?? null
      o.account_label = this.ordersNicknameFor({ source: src, seller_id: sellerId }, nick, accountId)
      const pid = (o as { product_id?: string | null }).product_id
      if (pid && thumbByProduct.has(pid)) {
        const items = o.order_items as Array<{ thumbnail?: string | null }> | undefined
        if (items?.length && !items[0].thumbnail) items[0].thumbnail = thumbByProduct.get(pid)!
      }
    }
  }

  /** Lista pedidos da Loja Própria (tabela `storefront_orders`).
   *
   *  Tabela tem schema diferente do `orders` (customer JSONB, items JSONB
   *  array, totais agregados — não 1 row por item como ML). Mapeamos pro
   *  shape canônico do `mapRowToFrontend` pra que o PedidosTable consuma
   *  igual qualquer outra origem. Tabs marketplace (mediação/flex/etc) não
   *  se aplicam — busca é flat com filtro de texto opcional. */
  async listStorefrontOrders(
    orgId: string | null,
    opts: { offset?: number; limit?: number; q?: string } = {},
  ) {
    const offset = Math.max(opts.offset ?? 0, 0)
    const limit  = Math.min(opts.limit  ?? 20, 200)

    let q = supabaseAdmin
      .from('storefront_orders')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })

    if (orgId) q = q.eq('organization_id', orgId)

    const search = opts.q?.trim()
    if (search) {
      const esc = search.replace(/[%]/g, '')
      // ILIKE em jsonb não rola direto — match em campos textuais top-level + id.
      // Filtro mais robusto (nome do cliente/email) precisaria função SQL custom.
      q = q.or(`id.ilike.%${esc}%,gateway_session_id.ilike.%${esc}%,gateway_payment_id.ilike.%${esc}%`)
    }

    q = q.range(offset, offset + limit - 1)

    const { data, error, count } = await q
    if (error) throw new Error(error.message)

    const orders = (data ?? []).map(row => mapStorefrontRowToCanonical(row as DbStorefrontOrderRow))
    return { orders, total: count ?? 0 }
  }

  /** Buscar thumbnails (fan-out cross-conta) + payments/shipping on-demand
   *  pra pedidos cujo raw_data não tem esses campos (worker rodou em código
   *  antigo). Não falha a listagem em caso de erro — log + skip.
   *
   *  - Thumbnails: 1 batch /items?ids=… por token. Barato.
   *  - Payments + shipping: GET /orders/{id} por pedido faltante.
   *    Limite duro de 8 orders/request pra não estourar quota.
   */
  private async enrichOrdersForUI(
    orgId: string,
    orders: Array<Record<string, unknown>>,
    sellerIdFilter?: number,
  ): Promise<void> {
    // Enriquecimento usa item/token do Mercado Livre — só faz sentido pra
    // pedidos ML. Em telas só de TikTok Shop / loja própria, pula o fan-out.
    if (!orders.some((o) => o.source === 'mercadolivre' || o.platform === 'mercadolivre')) {
      return
    }
    const tokens = sellerIdFilter == null
      ? await this.ml.getAllTokensForOrg(orgId).catch(() => [])
      : await this.ml.getTokenForOrg(orgId, sellerIdFilter).then(t => [t]).catch(() => [])

    if (tokens.length === 0) return

    // ── 1. Thumbnails — fan-out batch /items ────────────────────────────
    const itemIds = [...new Set(
      orders
        .flatMap(o => ((o.order_items as Array<Record<string, unknown>>) ?? []))
        .map(it => ((it.item as { id?: string } | undefined)?.id))
        .filter((id): id is string => !!id),
    )]
    const missingThumb = orders.some(o => {
      const items = (o.order_items as Array<{ item?: { thumbnail?: string | null } }>) ?? []
      return items.some(it => !it.item?.thumbnail)
    })

    const thumbMap: Record<string, { thumbnail: string; available_quantity: number | null; permalink: string | null }> = {}
    if (itemIds.length > 0 && (missingThumb || true)) {
      const idsToQuery = itemIds.slice(0, 50).join(',')
      const results = await Promise.allSettled(
        tokens.map(tk =>
          axios.get(`${ML_BASE}/items`, {
            headers: { Authorization: `Bearer ${tk.token}` },
            params:  { ids: idsToQuery, attributes: 'id,thumbnail,available_quantity,permalink,variations' },
            timeout: 6000,
          }),
        ),
      )
      for (const r of results) {
        if (r.status !== 'fulfilled') continue
        const batch = r.value.data
        ;(Array.isArray(batch) ? batch : [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((b: any) => b.code === 200)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .forEach((b: any) => {
            if (b.body?.id && !thumbMap[b.body.id]) {
              thumbMap[b.body.id] = {
                thumbnail:          b.body.thumbnail ?? '',
                available_quantity: b.body.available_quantity ?? null,
                permalink:          b.body.permalink ?? null,
              }
            }
          })
      }

      // Inject thumbs + available_quantity + permalink direto no order_items[i]
      // (top-level — shape canônico esperado pelo OrderCard)
      for (const o of orders) {
        const items = (o.order_items as Array<Record<string, unknown>>) ?? []
        for (const it of items) {
          const itemId = (it.item_id as string) ?? ((it.item as { id?: string } | undefined)?.id) ?? null
          if (itemId && thumbMap[itemId]) {
            const m = thumbMap[itemId]
            if (!it.thumbnail && m.thumbnail) it.thumbnail = m.thumbnail
            if (it.available_quantity == null) it.available_quantity = m.available_quantity
            if (!it.permalink && m.permalink)  it.permalink = m.permalink
          }
        }
      }
    }

    // ── 2. Payments + shipping detail — só pra orders sem payments ──────
    // Pedidos antigos têm payments=[]. Buscamos GET /orders/{id} pra
    // popular payments[], paid_amount, status_detail e shipping detalhado.
    // Cap em 8 pra não fazer 20 chamadas por pageload.
    const needsDetail = orders.filter(o => {
      const payments = (o.payments as unknown[] | undefined) ?? []
      return payments.length === 0
    }).slice(0, 8)

    if (needsDetail.length > 0) {
      // Acumula updates pra escrever em batch ao final (1 statement)
      const persistBuf: Array<{ external_order_id: string; raw_patch: Record<string, unknown> }> = []

      await Promise.allSettled(needsDetail.map(async (o) => {
        const orderId = o.order_id as number | string
        for (const tk of tokens) {
          try {
            const { data } = await axios.get<Record<string, unknown>>(
              `${ML_BASE}/orders/${orderId}`,
              {
                headers: { Authorization: `Bearer ${tk.token}`, 'x-version': '2' },
                timeout: 6000,
              },
            )
            // Sucesso (token tem acesso ao pedido): mescla campos faltantes
            const payments       = (data.payments       as unknown[]) ?? []
            const paidAmount     = data.paid_amount     as number | undefined
            const statusDetail   = data.status_detail   as unknown
            const shippingFull   = (data.shipping       as Record<string, unknown> | undefined) ?? {}
            const orderItemsFull = (data.order_items    as Array<Record<string, unknown>> | undefined) ?? []
            const packId         = data.pack_id
            const coupon         = data.coupon
            const context        = data.context

            // ── /shipments/{id} pra trazer receiver_name, lead_time,
            //    substatus, tracking_number — só vêm aqui, /orders não tem
            const shipId = (shippingFull.id as number | undefined) ?? null
            let shipmentDetail: Record<string, unknown> = {}
            if (shipId) {
              try {
                const { data: sd } = await axios.get<Record<string, unknown>>(
                  `${ML_BASE}/shipments/${shipId}`,
                  {
                    headers: { Authorization: `Bearer ${tk.token}`, 'x-version': '2' },
                    timeout: 6000,
                  },
                )
                shipmentDetail = sd
              } catch { /* skip — endpoint pode estar restrito */ }
            }

            // Mescla shipping: dados de /orders + dados de /shipments
            const shippingMerged: Record<string, unknown> = {
              ...shippingFull,
              receiver_address: shippingFull.receiver_address ?? shipmentDetail.receiver_address ?? null,
              receiver_name:    (shipmentDetail.receiver_address as Record<string, unknown> | undefined)?.receiver_name
                                ?? shipmentDetail.receiver_name
                                ?? null,
              substatus:        shipmentDetail.substatus     ?? shippingFull.substatus     ?? null,
              tracking_number:  shipmentDetail.tracking_number ?? null,
              tracking_method:  shipmentDetail.tracking_method ?? null,
              service_id:       shipmentDetail.service_id      ?? null,
              lead_time:        shipmentDetail.lead_time       ?? null,
              mode:             shipmentDetail.mode             ?? shippingFull.mode             ?? null,
              delivery_type:    (shipmentDetail.lead_time as Record<string, unknown> | undefined)?.shipping_method ?? null,
              base_cost:        shipmentDetail.base_cost        ?? shippingFull.base_cost        ?? 0,
            }

            if (payments.length > 0) o.payments = payments
            if (paidAmount != null)   o.paid_amount = paidAmount
            if (statusDetail != null) o.status_detail = statusDetail
            if (packId != null)       o.pack_id = packId
            if (coupon != null)       o.coupon  = coupon
            if (context != null)      o.context = context
            if (Object.keys(shippingMerged).length > 0) {
              const cur = (o.shipping as Record<string, unknown>) ?? {}
              o.shipping = { ...cur, ...shippingMerged }
            }
            // Mescla order_items[0] com title/variation_attributes/full_unit_price
            // vindos do /orders/{id} (mais ricos que o que worker salvou)
            const oiCur = ((o.order_items as Array<Record<string, unknown>>) ?? [])[0]
            const oiNew = orderItemsFull[0]
            if (oiCur && oiNew) {
              const itm = (oiNew.item as Record<string, unknown> | undefined) ?? {}
              if (!oiCur.title          && itm.title)                oiCur.title = itm.title
              if (!oiCur.seller_sku     && itm.seller_sku)           oiCur.seller_sku = itm.seller_sku
              if (!oiCur.variation_id   && itm.variation_id)         oiCur.variation_id = itm.variation_id
              const va = (itm.variation_attributes as unknown[]) ?? []
              if (va.length > 0)                                      oiCur.variation_attributes = va
              if (oiNew.full_unit_price != null)                      oiCur.full_unit_price = oiNew.full_unit_price
            }

            // Persiste no raw_data pra próxima página não re-buscar
            persistBuf.push({
              external_order_id: String(orderId),
              raw_patch: {
                payments,
                paid_amount:   paidAmount ?? null,
                status_detail: statusDetail ?? null,
                pack_id:       packId ?? null,
                coupon:        coupon ?? null,
                context:       context ?? null,
                shipping:      Object.keys(shippingMerged).length > 0 ? shippingMerged : null,
                // Persiste item enriquecido (variation_attributes + title + seller_sku)
                item:          oiCur ? {
                  id:                   oiCur.item_id ?? (oiCur.item as { id?: string } | undefined)?.id ?? null,
                  title:                oiCur.title,
                  seller_sku:           oiCur.seller_sku,
                  thumbnail:            oiCur.thumbnail ?? null,
                  variation_id:         oiCur.variation_id,
                  variation_attributes: oiCur.variation_attributes,
                  quantity:             oiCur.quantity,
                  unit_price:           oiCur.unit_price,
                  full_unit_price:      oiCur.full_unit_price,
                  sale_fee:             oiCur.sale_fee,
                } : null,
              },
            })
            return // sucesso, não tenta outros tokens
          } catch {
            // 401/403 → token errado, tenta próximo. 404 → pedido fora de janela.
            continue
          }
        }
      }))

      // Persiste enrichments — usa raw_data jsonb merge via SQL.
      // Não bloqueia retorno se falhar (logger.warn).
      if (persistBuf.length > 0) {
        await Promise.allSettled(persistBuf.map(async ({ external_order_id, raw_patch }) => {
          // Lê raw_data atual e mescla — Supabase não tem `||` operator no client
          const { data: current } = await supabaseAdmin
            .from('orders')
            .select('raw_data')
            .eq('external_order_id', external_order_id)
            .eq('organization_id', orgId)
            .maybeSingle()

          const merged = {
            ...((current?.raw_data as Record<string, unknown>) ?? {}),
            ...raw_patch,
          }

          await supabaseAdmin
            .from('orders')
            .update({ raw_data: merged })
            .eq('external_order_id', external_order_id)
            .eq('organization_id', orgId)
        })).catch(err => this.logger.warn(`[orders.list.enrich.persist] ${(err as Error).message}`))
      }
    }
  }

  /** KPIs agregados pra header da tela de pedidos.
   *  Today / current_month / last_month — lê do DB (snapshot ingerido). */
  /** Conta pedidos por tab — usado pelas badges das abas em /pedidos.
   *  Antes a tela contava só o que estava na página atual (10 itens),
   *  então as badges eram enganosas. Aqui rodamos count exact por tab
   *  em paralelo (head:true = sem fetch de rows). */
  async listOrdersTabCounts(
    orgId: string | null,
    sellerId?: number,
    platform?: 'mercadolivre' | 'manual' | 'tiktok_shop' | 'shopee' | 'storefront' | 'all',
    accountId?: string,
  ): Promise<{
    abertas: number; em_preparacao: number; despachadas: number;
    pgto_pendente: number; flex: number; encerradas: number; mediacao: number;
    canceladas: number;
  }> {
    if (platform === 'storefront') {
      return this.listStorefrontTabCounts(orgId)
    }

    const buildBase = () => {
      let q = supabaseAdmin.from('orders').select('*', { count: 'exact', head: true })
      if (orgId)     q = q.eq('organization_id', orgId)
      if (sellerId)  q = q.eq('seller_id', sellerId)
      if (accountId) q = q.eq('channel_account_id', accountId)
      if (platform === 'mercadolivre')      q = q.eq('source', 'mercadolivre')
      else if (platform === 'manual')       q = q.eq('source', 'manual')
      else if (platform === 'tiktok_shop')  q = q.eq('source', 'tiktok_shop')
      else if (platform === 'shopee')       q = q.eq('source', 'shopee')
      else                                  q = q.in('source', ['mercadolivre', 'manual', 'tiktok_shop', 'shopee'])
      return q
    }

    const [abertas, em_preparacao, despachadas, pgto_pendente, flex, encerradas, mediacao, canceladas] = await Promise.all([
      buildBase()
        .not('status', 'in', '(cancelled,payment_required,payment_in_process)')
        .or('shipping_status.is.null,shipping_status.in.(pending,not_specified)')
        .then(r => r.count ?? 0),
      buildBase()
        .neq('status', 'cancelled')
        .in('shipping_status', ['handling', 'ready_to_ship'])
        .then(r => r.count ?? 0),
      buildBase()
        .neq('status', 'cancelled')
        .in('shipping_status', ['shipped', 'in_transit'])
        .then(r => r.count ?? 0),
      buildBase()
        .in('status', ['payment_required', 'payment_in_process'])
        .then(r => r.count ?? 0),
      buildBase()
        .neq('status', 'cancelled')
        .eq('raw_data->shipping->>logistic_type', 'self_service')
        .then(r => r.count ?? 0),
      buildBase()
        .or('status.eq.cancelled,shipping_status.in.(delivered,not_delivered)')
        .then(r => r.count ?? 0),
      buildBase()
        .or('raw_data->mediations.cs.[{}],raw_data->tags.cs.["mediation_in_progress"]')
        .then(r => r.count ?? 0),
      // Canceladas — count INDEPENDENTE (pode sobrepor com mediacao e encerradas).
      // Opção C: visibilidade dupla pra auditoria/dispute.
      buildBase()
        .eq('status', 'cancelled')
        .then(r => r.count ?? 0),
    ])

    return { abertas, em_preparacao, despachadas, pgto_pendente, flex, encerradas, mediacao, canceladas }
  }

  /** Counts de tabs pra Loja Própria. Mapeia status próprio nas abas que
   *  o frontend já usa, pra mesma UI funcionar sem refactor:
   *    pgto_pendente  ← pending + awaiting_payment
   *    em_preparacao  ← paid (= aguardando envio pelo lojista)
   *    encerradas     ← refunded (entregue + reembolsado já não tá nesse fluxo)
   *    canceladas     ← failed + cancelled + expired
   *  abertas/despachadas/flex/mediacao não se aplicam → 0. */
  private async listStorefrontTabCounts(orgId: string | null): Promise<{
    abertas: number; em_preparacao: number; despachadas: number;
    pgto_pendente: number; flex: number; encerradas: number; mediacao: number;
    canceladas: number;
  }> {
    const baseQ = () => {
      let q = supabaseAdmin.from('storefront_orders').select('*', { count: 'exact', head: true })
      if (orgId) q = q.eq('organization_id', orgId)
      return q
    }
    const [pendingPay, paid, cancelled, refunded] = await Promise.all([
      baseQ().in('status', ['pending', 'awaiting_payment']).then(r => r.count ?? 0),
      baseQ().eq('status', 'paid').then(r => r.count ?? 0),
      baseQ().in('status', ['failed', 'cancelled', 'expired']).then(r => r.count ?? 0),
      baseQ().eq('status', 'refunded').then(r => r.count ?? 0),
    ])
    return {
      abertas:        0,
      em_preparacao:  paid,
      despachadas:    0,
      pgto_pendente:  pendingPay,
      flex:           0,
      encerradas:     refunded,
      mediacao:       0,
      canceladas:     cancelled,
    }
  }

  async listOrdersKpis(
    orgId: string | null,
    sellerId?: number,
    platform?: 'mercadolivre' | 'manual' | 'tiktok_shop' | 'shopee' | 'storefront' | 'all',
    accountId?: string,
  ) {
    if (platform === 'storefront') {
      return this.listStorefrontKpis(orgId)
    }
    const now = new Date()
    const todayFr = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const curFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const prvFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
    const prvTo   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()

    type Agg = { count: number; revenue: number; pending_shipment: number; in_transit: number; delivered: number; by_day: Array<{ date: string; count: number; revenue: number }> }

    const aggregateRange = async (from: string, to?: string): Promise<Agg> => {
      // Pagina explicitamente — Supabase corta silenciosamente em 1000 rows
      // por padrão. Sem isso, mês com >1000 pedidos retorna count e revenue
      // truncados (caso real Vazzo abril/2026: 1222 pedidos viraram 1000).
      const PAGE_SIZE  = 1000
      const SAFETY_CAP = 50_000  // ~1.5y mesmo pra contas grandes
      type Row = { sold_at: string; sale_price: number; quantity: number; shipping_status: string | null }
      const allRows: Row[] = []
      let pageStart = 0

      while (pageStart < SAFETY_CAP) {
        let q = supabaseAdmin
          .from('orders')
          .select('sold_at, sale_price, quantity, status, shipping_status')
          .gte('sold_at', from)
          .neq('status', 'cancelled')
          .neq('status', 'invalid')
        if (to)         q = q.lte('sold_at', to)
        if (orgId)      q = q.eq('organization_id', orgId)
        if (sellerId)   q = q.eq('seller_id', sellerId)
        if (accountId)  q = q.eq('channel_account_id', accountId)
        if (platform === 'mercadolivre')      q = q.eq('source', 'mercadolivre')
        else if (platform === 'manual')       q = q.eq('source', 'manual')
        else if (platform === 'tiktok_shop')  q = q.eq('source', 'tiktok_shop')
        else if (platform === 'shopee')       q = q.eq('source', 'shopee')
        else                                  q = q.in('source', ['mercadolivre', 'manual', 'tiktok_shop', 'shopee'])
        q = q.range(pageStart, pageStart + PAGE_SIZE - 1)

        const { data, error } = await q
        if (error) throw new Error(error.message)
        const page = (data ?? []) as Row[]
        if (page.length === 0) break
        allRows.push(...page)
        if (page.length < PAGE_SIZE) break
        pageStart += PAGE_SIZE
      }

      const byDay: Record<string, { count: number; revenue: number }> = {}
      let count = 0, revenue = 0, pendingShipment = 0, inTransit = 0, delivered = 0
      for (const row of allRows) {
        const d = (row.sold_at ?? '').substring(0, 10)
        const orderRevenue = (row.sale_price ?? 0) * (row.quantity ?? 1)
        if (d) {
          byDay[d] = byDay[d] ?? { count: 0, revenue: 0 }
          byDay[d].count++
          byDay[d].revenue += orderRevenue
        }
        count++
        revenue += orderRevenue
        const ss = row.shipping_status ?? ''
        if (ss === 'pending' || ss === 'ready_to_ship' || ss === 'handling') pendingShipment++
        else if (ss === 'shipped' || ss === 'in_transit')                    inTransit++
        else if (ss === 'delivered')                                         delivered++
      }
      return {
        count,
        revenue: Math.round(revenue * 100) / 100,
        pending_shipment: pendingShipment,
        in_transit:       inTransit,
        delivered,
        by_day: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, v]) => ({ date, count: v.count, revenue: Math.round(v.revenue * 100) / 100 })),
      }
    }

    const [today, currentMonth, lastMonth] = await Promise.all([
      aggregateRange(todayFr),
      aggregateRange(curFrom),
      aggregateRange(prvFrom, prvTo),
    ])

    return { today, current_month: currentMonth, last_month: lastMonth }
  }

  /** KPIs específicos da Loja Própria. Lê de storefront_orders e retorna
   *  shape compatível com a UI (count, revenue, by_day). Pendentes de
   *  envio = pedidos pagos. Em trânsito/entregue = 0 (loja própria não
   *  trackeia entrega ainda — feature futura). */
  private async listStorefrontKpis(orgId: string | null) {
    const now      = new Date()
    const todayFr  = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const curFrom  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const prvFrom  = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
    const prvTo    = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()

    type Agg = { count: number; revenue: number; pending_shipment: number; in_transit: number; delivered: number; by_day: Array<{ date: string; count: number; revenue: number }> }
    type Row = { created_at: string; total: number; status: string }

    const aggregate = async (from: string, to?: string): Promise<Agg> => {
      const PAGE = 1000
      const all: Row[] = []
      let start = 0
      while (start < 50_000) {
        let q = supabaseAdmin
          .from('storefront_orders')
          .select('created_at, total, status')
          .gte('created_at', from)
          .in('status', ['paid', 'refunded'])  // só conta pedidos confirmados
        if (to)    q = q.lte('created_at', to)
        if (orgId) q = q.eq('organization_id', orgId)
        q = q.range(start, start + PAGE - 1)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        const page = (data ?? []) as Row[]
        if (page.length === 0) break
        all.push(...page)
        if (page.length < PAGE) break
        start += PAGE
      }

      const byDay: Record<string, { count: number; revenue: number }> = {}
      let count = 0, revenue = 0, pendingShipment = 0
      for (const r of all) {
        const d = (r.created_at ?? '').substring(0, 10)
        const v = Number(r.total ?? 0)
        if (d) {
          byDay[d] = byDay[d] ?? { count: 0, revenue: 0 }
          byDay[d].count++
          byDay[d].revenue += v
        }
        count++
        revenue += v
        if (r.status === 'paid') pendingShipment++
      }
      return {
        count,
        revenue: Math.round(revenue * 100) / 100,
        pending_shipment: pendingShipment,
        in_transit: 0,
        delivered: 0,
        by_day: Object.entries(byDay)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, v]) => ({ date, count: v.count, revenue: Math.round(v.revenue * 100) / 100 })),
      }
    }

    const [today, currentMonth, lastMonth] = await Promise.all([
      aggregate(todayFr),
      aggregate(curFrom),
      aggregate(prvFrom, prvTo),
    ])
    return { today, current_month: currentMonth, last_month: lastMonth }
  }

  // ── TT-5c: endpoints agnósticos de canal pra dashboard + financeiro ─────
  // /orders/recent  → espelha /ml/recent-orders, mas pra TODAS as plataformas
  // /orders/financial-summary → espelha /ml/financial-summary, idem
  // Sem 401 quando ML não conectado; lê do `orders` unificado.

  /** Constrói mapa de account_nickname combinando ML + TikTok + Shopee. */
  private async ordersBuildNicknameMap(orgId: string): Promise<{
    ml: Record<number, string>
    tiktokSeller: string | null
    shopee: Record<string, string>
  }> {
    const [mlRes, ttsRes, shopeeRes] = await Promise.all([
      supabaseAdmin
        .from('ml_connections')
        .select('seller_id, nickname')
        .eq('organization_id', orgId),
      supabaseAdmin
        .from('tiktok_shop_credentials')
        .select('seller_name')
        .eq('organization_id', orgId)
        .maybeSingle<{ seller_name: string | null }>(),
      supabaseAdmin
        .from('marketplace_connections')
        .select('shop_id, nickname')
        .eq('organization_id', orgId)
        .eq('platform', 'shopee'),
    ])
    const ml: Record<number, string> = {}
    for (const c of (mlRes.data ?? []) as Array<{ seller_id: number; nickname: string | null }>) {
      ml[c.seller_id] = c.nickname ?? `Conta #${c.seller_id}`
    }
    const shopee: Record<string, string> = {}
    for (const c of (shopeeRes.data ?? []) as Array<{ shop_id: number | string | null; nickname: string | null }>) {
      if (c.shop_id != null) shopee[String(c.shop_id)] = c.nickname ?? `Shopee #${c.shop_id}`
    }
    return { ml, tiktokSeller: ttsRes.data?.seller_name ?? null, shopee }
  }

  private ordersNicknameFor(
    row: { source: string | null; seller_id: number | null },
    nick: { ml: Record<number, string>; tiktokSeller: string | null; shopee: Record<string, string> },
    channelAccountId?: string | null,
  ): string {
    if (row.source === 'tiktok_shop') return nick.tiktokSeller ?? 'TikTok Shop'
    if (row.source === 'shopee') {
      if (channelAccountId && nick.shopee[channelAccountId]) return nick.shopee[channelAccountId]
      return 'Shopee'
    }
    if (row.source === 'storefront') return 'Loja Própria'
    if (row.source === 'manual') return 'Manual'
    if (row.seller_id != null && nick.ml[row.seller_id]) return nick.ml[row.seller_id]
    return row.seller_id != null ? `Conta #${row.seller_id}` : 'Sem identificação'
  }

  /** Aliases legados de plataforma → canônico. `mercado_livre` (typo antigo)
   *  e `manual` (pedidos lançados à mão, sempre vinculados à conta ML) entram
   *  como Mercado Livre — evita pills/contas duplicadas no dashboard. */
  private canonPlatform(p: string): string {
    if (p === 'mercado_livre' || p === 'manual') return 'mercadolivre'
    return p
  }

  /** Expande o filtro de plataformas pros aliases legados, pra o filtro de ML
   *  não perder as linhas com platform='mercado_livre'/'manual'. */
  private expandPlatformsFilter(platforms: string[]): string[] {
    const out = new Set<string>()
    for (const p of platforms) {
      out.add(p)
      if (p === 'mercadolivre') { out.add('mercado_livre'); out.add('manual') }
    }
    return [...out]
  }

  /** Lista as contas que têm venda na org, agrupadas por (plataforma, seller_id).
   *  Data-driven: percorre `orders` e devolve combos distintos com nickname +
   *  contagem. Alimenta o seletor unificado do dashboard. */
  async getAccountsWithSales(orgId: string): Promise<
    Array<{ platform: string; seller_id: number | null; account_id: string | null; nickname: string; orders: number }>
  > {
    const nick = await this.ordersBuildNicknameMap(orgId)
    const PAGE_SIZE = 1000
    const SAFETY_CAP = 50_000
    const seen = new Map<
      string,
      { platform: string; seller_id: number | null; account_id: string | null; nickname: string; orders: number }
    >()
    let pageStart = 0
    while (pageStart < SAFETY_CAP) {
      const { data, error } = await supabaseAdmin
        .from('orders')
        .select('platform, source, seller_id, channel_account_id')
        .eq('organization_id', orgId)
        .range(pageStart, pageStart + PAGE_SIZE - 1)
      if (error) throw error
      const batch = (data ?? []) as Array<{
        platform: string | null
        source: string | null
        seller_id: number | null
        channel_account_id: string | null
      }>
      for (const r of batch) {
        // `platform` é a coluna que os filtros do dashboard usam; cai pra
        // `source` quando platform vier nulo (ingestões antigas). Canoniza
        // aliases legados (mercado_livre/manual → mercadolivre).
        const platform = this.canonPlatform(r.platform ?? r.source ?? 'unknown')
        // Loja do canal (shop_id Shopee/TikTok) separa contas dentro da mesma
        // plataforma — multi-loja. ML continua agrupado por seller_id.
        const key = `${platform}:${r.seller_id ?? 'null'}:${r.channel_account_id ?? 'null'}`
        const existing = seen.get(key)
        if (existing) {
          existing.orders++
        } else {
          seen.set(key, {
            platform,
            seller_id:  r.seller_id ?? null,
            account_id: r.channel_account_id ?? null,
            // Usa a plataforma CANÔNICA como source — assim a entrada ML
            // mesclada (que pode ter 1ª linha 'manual') resolve pro nick ML.
            nickname: this.ordersNicknameFor(
              { source: platform, seller_id: r.seller_id },
              nick,
              r.channel_account_id,
            ),
            orders: 1,
          })
        }
      }
      if (batch.length < PAGE_SIZE) break
      pageStart += PAGE_SIZE
    }
    return [...seen.values()].sort((a, b) => b.orders - a.orders)
  }

  /** Paginação manual — Supabase corta em 1000 sem .range(). */
  private async ordersFetchRowsForReport(opts: {
    orgId: string
    dateFrom?: string | null
    dateTo?: string | null
    statusFilter?: string
    sellerIdFilter?: number
    platformsFilter?: string[]
  }): Promise<OrdersReportRow[]> {
    const PAGE_SIZE = 1000
    const SAFETY_CAP = 50_000
    const rows: OrdersReportRow[] = []
    let pageStart = 0
    while (pageStart < SAFETY_CAP) {
      let q = supabaseAdmin
        .from('orders')
        .select(
          'id, source, platform, external_order_id, status, sold_at, seller_id, ' +
            'sku, product_title, quantity, sale_price, platform_fee, cost_price, ' +
            'tax_amount, shipping_cost, shipping_buyer_paid, contribution_margin, ' +
            'contribution_margin_pct, gross_profit, raw_data, marketplace_listing_id, ' +
            'billing_address',
        )
        .eq('organization_id', opts.orgId)
      if (opts.dateFrom) q = q.gte('sold_at', opts.dateFrom)
      if (opts.dateTo) q = q.lte('sold_at', opts.dateTo)
      if (opts.sellerIdFilter != null) q = q.eq('seller_id', opts.sellerIdFilter)
      if (opts.statusFilter && opts.statusFilter !== 'all') q = q.eq('status', opts.statusFilter)
      if (opts.platformsFilter && opts.platformsFilter.length > 0) {
        q = q.in('platform', this.expandPlatformsFilter(opts.platformsFilter))
      }
      q = q.order('sold_at', { ascending: false }).range(pageStart, pageStart + PAGE_SIZE - 1)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      const page = (data ?? []) as unknown as OrdersReportRow[]
      if (page.length === 0) break
      rows.push(...page)
      if (page.length < PAGE_SIZE) break
      pageStart += PAGE_SIZE
    }
    return rows
  }

  async getRecentOrders(
    orgId: string,
    offset = 0,
    limit = 50,
    dateFrom?: string,
    dateTo?: string,
    sellerIdFilter?: number,
    platforms?: string[],
  ) {
    const nick = await this.ordersBuildNicknameMap(orgId)
    const isoFrom = dateFrom ? `${dateFrom}T00:00:00.000-03:00` : null
    const isoTo = dateTo ? `${dateTo}T23:59:59.999-03:00` : null
    const allRows = await this.ordersFetchRowsForReport({
      orgId, dateFrom: isoFrom, dateTo: isoTo, sellerIdFilter, platformsFilter: platforms,
    })

    const sliceStart = Math.max(offset, 0)
    const sliceEnd = limit > 0 ? sliceStart + limit : allRows.length
    const paginated = allRows.slice(sliceStart, sliceEnd)

    const orders = paginated.map((row) => {
      const raw = (row.raw_data ?? {}) as Record<string, unknown>
      const itemRaw = (raw.item ?? {}) as Record<string, unknown>
      const shipping = (raw.shipping ?? {}) as Record<string, unknown>
      const billing = (row.billing_address ?? {}) as Record<string, unknown>
      let shippingState: string | null = null
      let shippingCity: string | null = null
      if (row.source === 'mercadolivre' || row.source === 'manual') {
        const recvAddr = (shipping.receiver_address as Record<string, unknown> | undefined) ?? {}
        const stateRaw = recvAddr.state ?? billing.state
        if (typeof stateRaw === 'string') {
          shippingState = stateRaw.startsWith('BR-') ? stateRaw.slice(3) : stateRaw
        } else if (stateRaw && typeof stateRaw === 'object') {
          const s = String(
            (stateRaw as { id?: unknown; name?: unknown }).id ??
              (stateRaw as { name?: unknown }).name ?? '',
          )
          shippingState = s.startsWith('BR-') ? s.slice(3) : s
        }
        const cityRaw = recvAddr.city ?? billing.city ?? billing.city_name
        if (typeof cityRaw === 'string') shippingCity = cityRaw
        else if (cityRaw && typeof cityRaw === 'object')
          shippingCity = (cityRaw as { name?: string }).name ?? null
      }
      const totalAmount = Number(row.sale_price ?? 0) * Number(row.quantity ?? 1)
      return {
        id: row.external_order_id,
        source: row.source,
        platform: row.platform,
        status: row.status,
        date_created: (raw.date_created as string) ?? row.sold_at,
        total_amount: totalAmount,
        seller_id: row.seller_id,
        account_nickname: this.ordersNicknameFor(row, nick),
        items: [{
          item_id: (itemRaw.id as string) ?? row.marketplace_listing_id ?? null,
          title: (itemRaw.title as string) ?? row.product_title,
          quantity: row.quantity ?? 1,
          unit_price: Number(row.sale_price ?? 0),
          seller_sku: row.sku ?? null,
        }],
        shipping_state: shippingState,
        shipping_city: shippingCity,
        platform_fee: Number(row.platform_fee ?? 0),
        shipping_cost: Number(row.shipping_cost ?? 0),
        shipping_buyer_paid: Number(row.shipping_buyer_paid ?? 0),
        cost_price: row.cost_price != null ? Number(row.cost_price) : null,
        tax_amount: row.tax_amount != null ? Number(row.tax_amount) : null,
        contribution_margin: row.contribution_margin != null ? Number(row.contribution_margin) : null,
        contribution_margin_pct: row.contribution_margin_pct != null ? Number(row.contribution_margin_pct) : null,
        gross_profit: row.gross_profit != null ? Number(row.gross_profit) : null,
      }
    })
    return { orders, total: allRows.length }
  }

  async getFinancialSummary(
    orgId: string,
    dateFrom: string,
    dateTo: string,
    statusFilter?: string,
    sellerIdFilter?: number,
    platforms?: string[],
  ) {
    const nick = await this.ordersBuildNicknameMap(orgId)
    // Normaliza pra dia-inteiro em BRT (igual getRecentOrders). Sem isso,
    // date_to='YYYY-MM-DD' vira meia-noite UTC e EXCLUI os pedidos de hoje.
    // Defensivo: só anexa hora quando vier data pura (sem 'T').
    const isoFrom = dateFrom && !dateFrom.includes('T') ? `${dateFrom}T00:00:00.000-03:00` : dateFrom
    const isoTo = dateTo && !dateTo.includes('T') ? `${dateTo}T23:59:59.999-03:00` : dateTo
    const allRows = await this.ordersFetchRowsForReport({
      orgId, dateFrom: isoFrom, dateTo: isoTo, statusFilter, sellerIdFilter, platformsFilter: platforms,
    })

    let faturamento = 0, canceladas = 0
    let tarifa_total = 0, frete_vendedor_total = 0, frete_comprador_total = 0
    let custo_total = 0, imposto_total = 0
    let qtd_aprovadas = 0, qtd_canceladas = 0
    let qtd_com_custo = 0, qtd_sem_custo = 0
    let fat_com_custo = 0

    const enrichedOrders = allRows.map((row) => {
      const totalAmount = Number(row.sale_price ?? 0) * Number(row.quantity ?? 1)
      const isCancelled = row.status === 'cancelled'
      const isInvalid = row.status === 'invalid'
      const tarifaML = Number(row.platform_fee ?? 0)
      const freteVendedor = Number(row.shipping_cost ?? 0)
      const freteComprador = Number(row.shipping_buyer_paid ?? 0)
      const costPrice = row.cost_price != null ? Number(row.cost_price) : null
      const taxAmount = row.tax_amount != null ? Number(row.tax_amount) : null
      const lucroBruto = row.gross_profit != null
        ? Number(row.gross_profit)
        : Math.round((totalAmount - tarifaML - freteVendedor) * 100) / 100
      const contribMargin = row.contribution_margin != null ? Number(row.contribution_margin) : null
      const contribMarginPct = row.contribution_margin_pct != null ? Number(row.contribution_margin_pct) : null

      if (!isCancelled && !isInvalid) {
        faturamento += totalAmount
        tarifa_total += tarifaML
        frete_vendedor_total += freteVendedor
        frete_comprador_total += freteComprador
        custo_total += costPrice ?? 0
        imposto_total += taxAmount ?? 0
        qtd_aprovadas++
        if (costPrice != null && costPrice > 0) { qtd_com_custo++; fat_com_custo += totalAmount }
        else qtd_sem_custo++
      } else if (isCancelled) {
        canceladas += totalAmount; qtd_canceladas++
      }

      const raw = (row.raw_data ?? {}) as Record<string, unknown>
      const itemRaw = (raw.item ?? {}) as Record<string, unknown>
      const shipping = (raw.shipping ?? {}) as Record<string, unknown>

      return {
        order_id: row.external_order_id,
        source: row.source,
        platform: row.platform,
        status: row.status,
        date_created: (raw.date_created as string) ?? row.sold_at,
        account_nickname: this.ordersNicknameFor(row, nick),
        seller_id: row.seller_id,
        item_id: (itemRaw.id as string) ?? row.marketplace_listing_id ?? null,
        title: (itemRaw.title as string) ?? row.product_title,
        sku: row.sku,
        thumbnail: (itemRaw.thumbnail as string) ?? null,
        quantity: row.quantity ?? 1,
        unit_price: Number(row.sale_price ?? 0),
        total_amount: totalAmount,
        shipping_type: (shipping.logistic_type as string) ?? null,
        frete_comprador: freteComprador,
        frete_vendedor: freteVendedor,
        tarifa_ml: tarifaML,
        cost_price: costPrice,
        tax_amount: taxAmount,
        lucro_bruto: lucroBruto,
        contribution_margin: contribMargin,
        contribution_margin_pct: contribMarginPct,
        is_paid: !isCancelled,
        is_cancelled: isCancelled,
      }
    })

    const r2 = (v: number) => Math.round(v * 100) / 100
    const vendas_aprovadas = faturamento - tarifa_total - frete_vendedor_total
    const margem_contribuicao = vendas_aprovadas - custo_total - imposto_total
    const margem_pct = faturamento > 0 ? Math.round((margem_contribuicao / faturamento) * 10000) / 100 : 0
    const ticket_medio = qtd_aprovadas > 0 ? Math.round((faturamento / qtd_aprovadas) * 100) / 100 : 0
    const ticket_medio_mc = qtd_aprovadas > 0 ? Math.round((margem_contribuicao / qtd_aprovadas) * 100) / 100 : 0
    const custo_pct_medio = fat_com_custo > 0 ? Math.round((custo_total / fat_com_custo) * 10000) / 100 : 0
    const custo_projetado = faturamento * (custo_pct_medio / 100)
    const margem_projetada = faturamento - tarifa_total - frete_vendedor_total - custo_projetado - imposto_total
    const margem_projetada_pct = faturamento > 0 ? Math.round((margem_projetada / faturamento) * 10000) / 100 : 0

    const kpis = {
      vendas_aprovadas: r2(vendas_aprovadas),
      // Mantém `faturamento_ml` no payload (dashboard/financeiro já leem essa
      // chave) — agora engloba TODAS as plataformas. Renomear pra
      // `faturamento_total` é refactor pra outra hora.
      faturamento_ml: r2(faturamento),
      canceladas: r2(canceladas),
      custo_total: r2(custo_total),
      imposto_total: r2(imposto_total),
      tarifa_total: r2(tarifa_total),
      frete_comprador: r2(frete_comprador_total),
      frete_vendedor: r2(frete_vendedor_total),
      frete_total: r2(frete_vendedor_total + frete_comprador_total),
      margem_contribuicao: r2(margem_contribuicao),
      margem_pct,
      qtd_aprovadas, qtd_canceladas,
      ticket_medio, ticket_medio_mc,
      qtd_com_custo, qtd_sem_custo,
      custo_pct_medio,
      margem_projetada: r2(margem_projetada),
      margem_projetada_pct,
    }
    const donutBase = faturamento || 1
    const donutData = [
      { name: 'Custo', value: r2(custo_total), pct: r2((custo_total / donutBase) * 100), color: '#f97316' },
      { name: 'Tarifa', value: r2(tarifa_total), pct: r2((tarifa_total / donutBase) * 100), color: '#f59e0b' },
      { name: 'Frete', value: r2(frete_vendedor_total), pct: r2((frete_vendedor_total / donutBase) * 100), color: '#3b82f6' },
      { name: 'Imposto', value: r2(imposto_total), pct: r2((imposto_total / donutBase) * 100), color: '#ef4444' },
      { name: 'M. Contribuição', value: r2(margem_contribuicao), pct: margem_pct, color: '#22c55e' },
    ]
    return { kpis, donutData, orders: enrichedOrders }
  }
}

type OrdersReportRow = {
  id: string
  source: string | null
  platform: string | null
  external_order_id: string
  status: string | null
  sold_at: string | null
  seller_id: number | null
  sku: string | null
  product_title: string | null
  quantity: number | null
  sale_price: number | null
  platform_fee: number | null
  cost_price: number | null
  tax_amount: number | null
  shipping_cost: number | null
  shipping_buyer_paid: number | null
  contribution_margin: number | null
  contribution_margin_pct: number | null
  gross_profit: number | null
  raw_data: Record<string, unknown> | null
  marketplace_listing_id: string | null
  billing_address: Record<string, unknown> | null
}

interface DbOrderRow {
  id?:              string
  source:           string | null
  platform:         string | null
  seller_id?:       number | null
  channel_account_id?: string | null
  product_id?:      string | null
  external_order_id: string
  status:           string | null
  shipping_id:      number | null
  shipping_status:  string | null
  payment_status:   string | null
  sold_at:          string | null
  created_at:       string | null
  sale_price:       number | null
  quantity:         number | null
  cost_price:       number | null
  platform_fee:        number | null
  shipping_cost:       number | null
  shipping_buyer_paid: number | null
  shipping_ml_refund:  number | null
  shipping_gross:      number | null
  tax_amount:          number | null
  gross_profit:     number | null
  contribution_margin:     number | null
  contribution_margin_pct: number | null
  buyer_name:       string | null
  buyer_last_name:  string | null
  buyer_username:   string | null
  buyer_doc_type:   string | null
  buyer_doc_number: string | null
  buyer_email:      string | null
  buyer_phone:      string | null
  billing_address:  Record<string, unknown> | null
  product_title:    string | null
  sku:              string | null
  marketplace_listing_id: string | null
  variation_id:     string | null
  raw_data:         Record<string, unknown> | null
  has_problem:      boolean | null
  problem_note:     string | null
  problem_severity: string | null
}

/** Converte row da tabela orders pro shape consumido por PedidosTable
 *  / OrderCard. raw_data tem shape simplificado salvo pelo worker
 *  (item singular, sem array order_items) — re-empacotamos pra
 *  o shape original retornado por /ml/orders/enriched. */
function mapRowToFrontend(row: DbOrderRow): Record<string, unknown> {
  const raw      = row.raw_data ?? {}
  const buyer    = (raw.buyer    ?? {}) as Record<string, unknown>
  const shipping = (raw.shipping ?? {}) as Record<string, unknown>
  const itemRaw  = (raw.item     ?? {}) as Record<string, unknown>
  const billing  = (row.billing_address ?? {}) as Record<string, unknown>

  // Endereço de entrega dos canais não-ML: Shopee/TikTok guardam o
  // recipient_address no TOPO do raw_data (shape próprio de cada API).
  // Normaliza pro shape canônico do card. Shopee pode vir MASCARADO
  // ("****") quando o app não tem acesso a dados sensíveis — mascara
  // vira null pra não poluir a tela.
  const unmask = (v: unknown): string | null => {
    if (typeof v !== 'string' || !v.trim()) return null
    return /^\*+$/.test(v.trim()) ? null : v
  }
  let channelReceiverAddr: Record<string, unknown> | undefined
  if (row.source === 'shopee' && raw.recipient_address) {
    const r = raw.recipient_address as Record<string, unknown>
    channelReceiverAddr = {
      zip_code:      unmask(r.zipcode),
      street_name:   unmask(r.full_address),
      street_number: null,
      complement:    null,
      neighborhood:  unmask(r.district) ?? unmask(r.town),
      city:          unmask(r.city),
      state:         unmask(r.state),
      address_line:  unmask(r.full_address),
    }
  } else if (row.source === 'tiktok_shop' && raw.recipient_address) {
    const r = raw.recipient_address as Record<string, unknown>
    channelReceiverAddr = {
      zip_code:      unmask(r.postal_code),
      street_name:   unmask(r.address_line2) ?? unmask(r.full_address),
      street_number: unmask(r.address_line3),
      complement:    unmask(r.address_line4),
      neighborhood:  unmask(r.address_line1),
      city:          null,
      state:         null,
      address_line:  unmask(r.full_address),
    }
  }

  // Fallback para receiver_address: ML só retorna receiver_address em
  // /shipments/{id}, que o worker NÃO chama. billing_address vem do
  // billing-info v2 e é geralmente igual ao endereço de entrega — usa
  // como fallback pra não deixar o card "Endereço de entrega" vazio.
  const shippingReceiverAddr =
    (shipping.receiver_address as Record<string, unknown> | undefined) ??
    channelReceiverAddr ??
    (Object.keys(billing).length > 0 ? {
      zip_code:      (billing.zip_code      as string) ?? (billing as { zip?: string }).zip ?? null,
      street_name:   (billing.street_name   as string) ?? null,
      street_number: (billing.street_number as string) ?? null,
      complement:    (billing.complement    as string) ?? (billing.comment as string) ?? null,
      neighborhood:  typeof billing.neighborhood === 'object'
        ? (billing.neighborhood as { name?: string }).name ?? null
        : (billing.neighborhood as string) ?? null,
      city:          typeof billing.city === 'object'
        ? (billing.city as { name?: string }).name ?? null
        : (billing.city as string) ?? null,
      state:         typeof billing.state === 'object'
        ? (billing.state as { name?: string }).name ?? (billing.state as { id?: string }).id ?? null
        : (billing.state as string) ?? null,
    } : {})

  // Worker salva item SINGULAR. Frontend espera order_items[] com shape
  // canônico de /ml/orders/enriched: item_id/title/seller_sku/thumbnail/
  // variation_attributes ficam no NÍVEL DE TOPO de cada order_items[i],
  // não aninhados em .item. OrderCard lê item.title direto onde
  // item = order.order_items[0].
  const orderItem = {
    item_id:              itemRaw.id            ?? row.marketplace_listing_id ?? null,
    item:                 { id: itemRaw.id ?? row.marketplace_listing_id ?? null }, // compat
    title:                itemRaw.title         ?? row.product_title          ?? null,
    seller_sku:           itemRaw.seller_sku    ?? row.sku                    ?? null,
    thumbnail:            itemRaw.thumbnail     ?? null,
    variation_id:         itemRaw.variation_id  ?? row.variation_id           ?? null,
    variation_attributes: (itemRaw.variation_attributes as unknown[]) ?? [],
    quantity:             itemRaw.quantity      ?? row.quantity               ?? 1,
    unit_price:           itemRaw.unit_price    ?? row.sale_price             ?? 0,
    full_unit_price:      itemRaw.full_unit_price ?? itemRaw.unit_price       ?? row.sale_price ?? 0,
    sale_fee:             itemRaw.sale_fee      ?? row.platform_fee           ?? 0,
  }

  // Shopee/TikTok: a linha do `orders` é POR SKU, mas raw_data.total_amount é
  // do PEDIDO inteiro — usa o valor da linha (sale_price já é o total do SKU).
  const isChannelRow = row.source === 'shopee' || row.source === 'tiktok_shop'
  const rowTotal     = Number(row.sale_price ?? 0)
  const totalAmount  = isChannelRow
    ? rowTotal
    : Number(raw.total_amount ?? ((row.sale_price ?? 0) * (row.quantity ?? 1)))

  // Pagamento sintetizado pros canais sem payments[] no raw (Shopee/TikTok):
  // método + valor + status aprovado quando o pedido está pago.
  let payments = (raw.payments as unknown[]) ?? []
  if (isChannelRow && (!Array.isArray(payments) || payments.length === 0)) {
    const method = (raw.payment_method as string)
      ?? ((raw.payment as Record<string, unknown> | undefined)?.payment_method_name as string)
      ?? (raw.payment_method_name as string)
      ?? null
    if (method || rowTotal > 0) {
      payments = [{
        id:                0,
        total_paid_amount: rowTotal,
        installments:      1,
        payment_type:      method ?? '—',
        status:            row.status === 'cancelled' ? 'cancelled'
                         : row.status === 'pending' || row.status === 'payment_in_process' ? 'pending'
                         : 'approved',
      }]
    }
  }

  return {
    order_id:      Number(row.external_order_id) || row.external_order_id,
    source:        row.source ?? null,
    platform:      row.platform ?? null,
    seller_id:     row.seller_id ?? null,
    channel_account_id: row.channel_account_id ?? null,
    product_id:    row.product_id ?? null,
    status:        row.status,
    status_detail: raw.status_detail ?? null,
    date_created:  raw.date_created ?? row.sold_at ?? row.created_at,
    date_closed:   raw.date_closed ?? null,
    total_amount:  totalAmount,
    paid_amount:   raw.paid_amount ?? null,
    payments,
    mediations:    raw.mediations ?? [],
    tags:          raw.tags ?? [],
    // Carrinho/agrupamento — quando ML agrupa pedidos do mesmo comprador
    pack_id:       raw.pack_id ?? null,
    // Cupom aplicado pelo seller (id, amount)
    coupon:        raw.coupon ?? null,
    // Descontos/estornos (campanhas comerciais — "Aplicamos uma redução de
    // R$ X na sua tarifa de venda porque você participou de uma campanha")
    discounts:     raw.discounts ?? null,
    // Indicador "venda por publicidade" (Mercado Ads)
    context:       raw.context ?? null,
    buyer: {
      ...buyer,
      doc_number: row.buyer_doc_number ?? (buyer as { doc_number?: string }).doc_number ?? null,
      doc_type:   row.buyer_doc_type   ?? (buyer as { doc_type?: string }).doc_type     ?? null,
      email:      row.buyer_email      ?? (buyer as { email?: string }).email           ?? null,
      phone_full: row.buyer_phone      ?? null,
      first_name: row.buyer_name?.split(' ')[0] ?? (buyer as { first_name?: string }).first_name ?? null,
      last_name:  row.buyer_last_name  ?? (buyer as { last_name?: string }).last_name   ?? null,
      nickname:   row.buyer_username   ?? (buyer as { nickname?: string }).nickname     ?? null,
    },
    shipping: {
      ...shipping,
      id:                row.shipping_id     ?? (shipping as { id?: number }).id            ?? null,
      status:            row.shipping_status ?? (shipping as { status?: string }).status    ?? null,
      logistic_type:     (shipping as { logistic_type?: string }).logistic_type             ?? null,
      // OrderCard acessa receiver_address.zip_code sem optional chaining —
      // mantém objeto (vazio se sem dados) em vez de null pra não quebrar a UI.
      receiver_address:        shippingReceiverAddr,
      receiver_name:           (shipping as { receiver_name?: string }).receiver_name
        ?? (isChannelRow ? unmask((raw.recipient_address as Record<string, unknown> | undefined)?.name) : null),
      receiver_cost:           (shipping as { receiver_cost?: number }).receiver_cost           ?? null,
      base_cost:               (shipping as { base_cost?: number }).base_cost                   ?? 0,
      estimated_delivery_date: (shipping as { estimated_delivery_date?: string }).estimated_delivery_date   ?? null,
      posting_deadline:        (shipping as { posting_deadline?: string }).posting_deadline
        // Shopee informa o prazo de postagem no topo do raw (ship_by_date epoch)
        ?? (row.source === 'shopee' && raw.ship_by_date
              ? new Date(Number(raw.ship_by_date) * 1000).toISOString()
              : null),
      date_created:            (shipping as { date_created?: string }).date_created                         ?? null,
      substatus:               (shipping as { substatus?: string }).substatus                               ?? null,
      tracking_number:         (shipping as { tracking_number?: string }).tracking_number
        ?? (isChannelRow ? ((raw.tracking_number as string) || null) : null),
      tracking_method:         (shipping as { tracking_method?: string }).tracking_method                   ?? null,
      service_id:              (shipping as { service_id?: number }).service_id                             ?? null,
      lead_time:               (shipping as { lead_time?: Record<string, unknown> }).lead_time              ?? null,
      mode:                    (shipping as { mode?: string }).mode                                         ?? null,
      delivery_type:           (shipping as { delivery_type?: string }).delivery_type                       ?? null,
    },
    order_items:   [orderItem],
    cost_price:    row.cost_price ?? 0,
    platform_fee:  row.platform_fee ?? 0,
    shipping_cost: row.shipping_cost ?? 0,
    tax_amount:    row.tax_amount ?? 0,
    gross_profit:  row.gross_profit ?? 0,
    contribution_margin:     row.contribution_margin ?? 0,
    contribution_margin_pct: row.contribution_margin_pct ?? 0,
    // Legacy aliases — OrderCard ainda lê os campos do shape antigo de
    // /ml/orders/enriched (tarifa_ml, frete_vendedor, lucro_bruto). Sem
    // estes aliases brl(undefined) quebra com "Cannot read properties of
    // undefined (reading 'toLocaleString')".
    tarifa_ml:        row.platform_fee  ?? 0,
    frete_vendedor:   row.shipping_cost ?? 0,
    frete_comprador:  row.shipping_buyer_paid ?? 0,
    lucro_bruto:      row.gross_profit  ?? 0,
    margem_contribuicao_pct: row.contribution_margin_pct ?? 0,
    // Breakdown novo do frete (Sprint UI extra) — UI mostra
    // tooltips detalhados + linha de reembolso ML
    shipping_breakdown: {
      buyer_paid:  row.shipping_buyer_paid ?? 0,
      ml_refund:   row.shipping_ml_refund  ?? 0,
      seller_paid: row.shipping_cost       ?? 0,
      gross:       row.shipping_gross      ?? 0,
    },
    has_problem:      row.has_problem,
    problem_note:     row.problem_note,
    problem_severity: row.problem_severity,
  }
}

// ── Loja Própria (storefront_orders) ────────────────────────────────────────

interface DbStorefrontOrderRow {
  id:                  string
  organization_id:     string
  store_slug:          string
  customer:            Record<string, unknown>
  items:               Array<Record<string, unknown>>
  subtotal:            number
  shipping:            number
  total:               number
  gateway:             string | null
  gateway_session_id:  string | null
  gateway_payment_id:  string | null
  status:              string
  shipping_status?:    string | null
  shipping_carrier?:   string | null
  tracking_code?:      string | null
  shipped_at?:         string | null
  delivered_at?:       string | null
  created_at:          string
  updated_at:          string
}

/** Mapeia 1 pedido da loja própria pro shape canônico consumido pelo
 *  PedidosTable. Mantém compatibilidade com OrderCard:
 *  - order_id = storefront_orders.id (uuid; string, não numérico)
 *  - status normalizado: pending/awaiting_payment→'payment_in_process',
 *    paid→'paid', cancelled/failed/expired→'cancelled', refunded→'refunded'
 *  - source/platform = 'storefront' pra FE identificar
 *  - order_items[] sintetizado a partir do JSON items[]
 *  - shipping.receiver_address derivado de customer.address
 *  - buyer.* extraído de customer
 */
function mapStorefrontRowToCanonical(row: DbStorefrontOrderRow): Record<string, unknown> {
  const customer = (row.customer ?? {}) as {
    name?: string; email?: string; phone?: string; doc?: string;
    address?: {
      zip?: string; street?: string; number?: string; complement?: string;
      neighborhood?: string; city?: string; state?: string;
    };
    notes?: string;
  }
  const items = Array.isArray(row.items) ? row.items : []

  // Status normalizado pra reaproveitar fluxos da UI marketplace
  let normalizedStatus: string
  switch (row.status) {
    case 'paid':              normalizedStatus = 'paid'; break
    case 'refunded':          normalizedStatus = 'refunded'; break
    case 'cancelled':
    case 'failed':
    case 'expired':           normalizedStatus = 'cancelled'; break
    case 'pending':
    case 'awaiting_payment':
    default:                  normalizedStatus = 'payment_in_process'
  }

  const [firstName, ...lastParts] = (customer.name ?? '').trim().split(/\s+/)
  const lastName = lastParts.join(' ') || null

  const addr = customer.address ?? {}
  const receiverAddress = {
    zip_code:      addr.zip ?? null,
    street_name:   addr.street ?? null,
    street_number: addr.number ?? null,
    complement:    addr.complement ?? null,
    neighborhood:  addr.neighborhood ?? null,
    city:          addr.city ?? null,
    state:         addr.state ?? null,
  }

  // Sintetiza order_items[] no shape esperado. Primeiro item agrega título
  // pra Card; demais aparecem na expansão.
  const totalQty = items.reduce((s, it) => s + Number((it as { qty?: number }).qty ?? 1), 0)
  const orderItems = items.map((it, idx) => {
    const i = it as { productId?: string; name?: string; price?: number; qty?: number; imageUrl?: string }
    return {
      item_id:              i.productId ?? `STORE-ITEM-${idx}`,
      item:                 { id: i.productId ?? null },
      title:                i.name ?? `Item ${idx + 1}`,
      seller_sku:           i.productId ?? null,
      thumbnail:            i.imageUrl ?? null,
      variation_id:         null,
      variation_attributes: [],
      quantity:             i.qty ?? 1,
      unit_price:           i.price ?? 0,
      full_unit_price:      i.price ?? 0,
      sale_fee:             0,
    }
  })
  if (orderItems.length === 0) {
    // Pedido sem items (corrupto) — fallback pra UI não quebrar.
    orderItems.push({
      item_id: 'STORE-EMPTY', item: { id: null }, title: 'Pedido sem itens',
      seller_sku: null, thumbnail: null, variation_id: null,
      variation_attributes: [], quantity: 1,
      unit_price: Number(row.total ?? 0),
      full_unit_price: Number(row.total ?? 0), sale_fee: 0,
    })
  }

  return {
    order_id:      row.id,
    status:        normalizedStatus,
    status_detail: null,
    date_created:  row.created_at,
    date_closed:   normalizedStatus === 'paid' ? row.updated_at : null,
    total_amount:  Number(row.total ?? 0),
    paid_amount:   normalizedStatus === 'paid' ? Number(row.total ?? 0) : null,
    payments:      row.gateway_payment_id ? [{ id: row.gateway_payment_id, status: row.status, transaction_amount: Number(row.total ?? 0) }] : [],
    mediations:    [],
    tags:          ['storefront'],  // FE pode identificar origem
    pack_id:       null,
    coupon:        null,
    discounts:     null,
    context:       null,
    // Marcadores de origem — PedidosTable pode renderizar badge "Loja"
    source:        'storefront',
    platform:      'storefront',
    store_slug:    row.store_slug,
    gateway:       row.gateway,
    buyer: {
      first_name: firstName || null,
      last_name:  lastName,
      email:      customer.email ?? null,
      phone_full: customer.phone ?? null,
      doc_number: customer.doc ?? null,
      doc_type:   null,
      nickname:   null,
    },
    shipping: {
      id:                null,
      // Usa shipping_status real do storefront_orders (mapeado pelo lojista)
      status:            row.shipping_status ?? (normalizedStatus === 'paid' ? 'pending' : null),
      logistic_type:     null,
      receiver_address:  receiverAddress,
      receiver_name:     customer.name ?? null,
      receiver_cost:     null,
      base_cost:         Number(row.shipping ?? 0),
      estimated_delivery_date: null,
      posting_deadline:        null,
      date_created:            row.shipped_at ?? null,
      substatus:               null,
      tracking_number:         row.tracking_code ?? null,
      tracking_method:         row.shipping_carrier ?? null,
      service_id:              null,
      lead_time:               null,
      mode:                    null,
      delivery_type:           null,
    },
    // Marcadores explícitos pra UI de storefront
    storefront_shipping: {
      status:   row.shipping_status ?? 'pending',
      carrier:  row.shipping_carrier ?? null,
      code:     row.tracking_code ?? null,
      shipped_at:   row.shipped_at ?? null,
      delivered_at: row.delivered_at ?? null,
    },
    order_items:   orderItems,
    cost_price:    0,
    platform_fee:  0,
    shipping_cost: Number(row.shipping ?? 0),
    tax_amount:    0,
    gross_profit:  Number(row.total ?? 0) - Number(row.shipping ?? 0),
    contribution_margin:     0,
    contribution_margin_pct: 0,
    tarifa_ml:        0,
    frete_vendedor:   Number(row.shipping ?? 0),
    frete_comprador:  Number(row.shipping ?? 0),
    lucro_bruto:      Number(row.total ?? 0) - Number(row.shipping ?? 0),
    margem_contribuicao_pct: 0,
    shipping_breakdown: {
      buyer_paid:  Number(row.shipping ?? 0),
      ml_refund:   0,
      seller_paid: 0,
      gross:       Number(row.shipping ?? 0),
    },
    // Resumo agregado pro Card mostrar "X itens"
    items_summary: totalQty > 1 ? `${totalQty} itens` : null,
    has_problem:      null,
    problem_note:     null,
    problem_severity: null,
  }
}
