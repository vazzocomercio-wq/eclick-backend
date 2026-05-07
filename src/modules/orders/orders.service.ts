import { Injectable, Logger } from '@nestjs/common'
import axios from 'axios'
import { supabaseAdmin } from '../../common/supabase'
import { MercadolivreService } from '../mercadolivre/mercadolivre.service'

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
    const platformFee = dto.platform === 'ml' ? dto.sale_price * 0.115 : 0
    const shippingCost = 0
    const grossProfit = dto.sale_price - platformFee - shippingCost - (dto.cost_price ?? 0)
    const marginPct = dto.sale_price > 0 ? (grossProfit / dto.sale_price) * 100 : 0

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
        platform_fee:           Math.round(platformFee * 100) / 100,
        shipping_cost:          shippingCost,
        gross_profit:           Math.round(grossProfit * 100) / 100,
        contribution_margin:    Math.round(grossProfit * 100) / 100,
        contribution_margin_pct: Math.round(marginPct * 100) / 100,
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
      offset?:    number
      limit?:     number
      q?:         string
      seller_id?: number
      tab?:       'abertas' | 'em_preparacao' | 'despachadas' | 'pgto_pendente' | 'flex' | 'encerradas' | 'mediacao'
    } = {},
  ) {
    const offset = Math.max(options.offset ?? 0, 0)
    const limit  = Math.min(options.limit  ?? 20, 200)

    let q = supabaseAdmin
      .from('orders')
      .select('*', { count: 'exact' })
      .order('sold_at', { ascending: false })

    if (orgId)              q = q.eq('organization_id', orgId)
    if (options.seller_id)  q = q.eq('seller_id',       options.seller_id)
    q = q.in('source', ['mercadolivre', 'manual'])

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
    }

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
  async listOrdersKpis(orgId: string | null, sellerId?: number) {
    const now = new Date()
    const todayFr = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const curFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const prvFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
    const prvTo   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString()

    type Agg = { count: number; revenue: number; pending_shipment: number; in_transit: number; delivered: number; by_day: Array<{ date: string; count: number; revenue: number }> }

    const aggregateRange = async (from: string, to?: string): Promise<Agg> => {
      let q = supabaseAdmin
        .from('orders')
        .select('sold_at, sale_price, quantity, status, shipping_status')
        .gte('sold_at', from)
        .neq('status', 'cancelled')
        .neq('status', 'invalid')
      if (to)         q = q.lte('sold_at', to)
      if (orgId)      q = q.eq('organization_id', orgId)
      if (sellerId)   q = q.eq('seller_id', sellerId)
      q = q.in('source', ['mercadolivre', 'manual'])

      const { data, error } = await q
      if (error) throw new Error(error.message)

      const byDay: Record<string, { count: number; revenue: number }> = {}
      let count = 0, revenue = 0, pendingShipment = 0, inTransit = 0, delivered = 0
      for (const row of (data ?? []) as Array<{ sold_at: string; sale_price: number; quantity: number; shipping_status: string | null }>) {
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
}

interface DbOrderRow {
  id?:              string
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
  platform_fee:     number | null
  shipping_cost:    number | null
  tax_amount:       number | null
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

  // Fallback para receiver_address: ML só retorna receiver_address em
  // /shipments/{id}, que o worker NÃO chama. billing_address vem do
  // billing-info v2 e é geralmente igual ao endereço de entrega — usa
  // como fallback pra não deixar o card "Endereço de entrega" vazio.
  const shippingReceiverAddr =
    (shipping.receiver_address as Record<string, unknown> | undefined) ??
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

  return {
    order_id:      Number(row.external_order_id) || row.external_order_id,
    status:        row.status,
    status_detail: raw.status_detail ?? null,
    date_created:  raw.date_created ?? row.sold_at ?? row.created_at,
    date_closed:   raw.date_closed ?? null,
    total_amount:  Number(raw.total_amount ?? ((row.sale_price ?? 0) * (row.quantity ?? 1))),
    paid_amount:   raw.paid_amount ?? null,
    payments:      raw.payments ?? [],
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
      receiver_name:           (shipping as { receiver_name?: string }).receiver_name           ?? null,
      receiver_cost:           (shipping as { receiver_cost?: number }).receiver_cost           ?? null,
      base_cost:               (shipping as { base_cost?: number }).base_cost                   ?? 0,
      estimated_delivery_date: (shipping as { estimated_delivery_date?: string }).estimated_delivery_date   ?? null,
      posting_deadline:        (shipping as { posting_deadline?: string }).posting_deadline                 ?? null,
      date_created:            (shipping as { date_created?: string }).date_created                         ?? null,
      substatus:               (shipping as { substatus?: string }).substatus                               ?? null,
      tracking_number:         (shipping as { tracking_number?: string }).tracking_number                   ?? null,
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
    frete_comprador:  0,
    lucro_bruto:      row.gross_profit  ?? 0,
    margem_contribuicao_pct: row.contribution_margin_pct ?? 0,
    has_problem:      row.has_problem,
    problem_note:     row.problem_note,
    problem_severity: row.problem_severity,
  }
}
