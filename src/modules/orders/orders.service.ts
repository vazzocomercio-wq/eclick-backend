import { Injectable } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

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
    return { orders, total: count ?? 0 }
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
 *  (era retornado por /ml/orders/enriched). raw_data já tem buyer/shipping/etc
 *  vindos do ML — só re-empacotamos os campos calculados (margem, custos). */
function mapRowToFrontend(row: DbOrderRow): Record<string, unknown> {
  const raw = row.raw_data ?? {}
  const buyer = (raw.buyer ?? {}) as Record<string, unknown>
  const shipping = (raw.shipping ?? {}) as Record<string, unknown>
  const items = (raw.order_items ?? []) as Array<Record<string, unknown>>

  return {
    order_id:      Number(row.external_order_id),
    status:        row.status,
    status_detail: raw.status_detail ?? null,
    date_created:  raw.date_created ?? row.sold_at ?? row.created_at,
    date_closed:   raw.date_closed ?? null,
    total_amount:  (row.sale_price ?? 0) * (row.quantity ?? 1),
    paid_amount:   raw.paid_amount ?? null,
    payments:      raw.payments ?? [],
    mediations:    raw.mediations ?? [],
    tags:          raw.tags ?? [],
    buyer: {
      ...buyer,
      doc_number:  row.buyer_doc_number ?? (buyer.doc_number ?? null),
      doc_type:    (buyer as { doc_type?: string }).doc_type ?? null,
      email:       row.buyer_email ?? (buyer as { email?: string }).email ?? null,
      phone_full:  row.buyer_phone ?? null,
      first_name:  row.buyer_name?.split(' ')[0] ?? (buyer as { first_name?: string }).first_name ?? null,
      last_name:   row.buyer_last_name ?? (buyer as { last_name?: string }).last_name ?? null,
      nickname:    row.buyer_username ?? (buyer as { nickname?: string }).nickname ?? null,
    },
    shipping: {
      ...shipping,
      id:                 row.shipping_id ?? (shipping as { id?: number }).id ?? null,
      status:             row.shipping_status ?? (shipping as { status?: string }).status ?? null,
      logistic_type:      (shipping as { logistic_type?: string }).logistic_type ?? null,
      receiver_address:   (shipping as { receiver_address?: unknown }).receiver_address ?? null,
    },
    order_items:   items,
    // Custos calculados pelo worker (líquidos, corretos)
    cost_price:    row.cost_price,
    platform_fee:  row.platform_fee,
    shipping_cost: row.shipping_cost,
    tax_amount:    row.tax_amount,
    gross_profit:  row.gross_profit,
    contribution_margin:     row.contribution_margin,
    contribution_margin_pct: row.contribution_margin_pct,
    // Flags adicionais
    has_problem:      row.has_problem,
    problem_note:     row.problem_note,
    problem_severity: row.problem_severity,
  }
}
