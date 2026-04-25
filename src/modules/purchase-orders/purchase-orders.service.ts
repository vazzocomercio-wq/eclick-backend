import { Injectable, HttpException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

const STATUS_FLOW: Record<string, string> = {
  draft:         'pending',
  pending:       'ordered',
  ordered:       'in_production',
  in_production: 'in_transit',
  in_transit:    'customs',
  customs:       'received',
}

const PO_SELECT = `
  id, po_number, status, expected_arrival_date, currency, exchange_rate,
  incoterm, subtotal, freight_cost, other_costs, total_cost,
  ordered_at, created_at, tracking_number, carrier,
  container_number, bl_number, notes, internal_notes, supplier_id,
  suppliers(id, name, country, supplier_type),
  purchase_order_items(
    id, product_id, quantity, unit_cost, subtotal, quantity_received,
    expected_arrival_date, actual_arrival_date,
    products(id, name, sku, photo_urls)
  )
`

@Injectable()
export class PurchaseOrdersService {

  private async assertOwnership(orgId: string, poId: string) {
    const { data, error } = await supabaseAdmin
      .from('purchase_orders')
      .select('id, status')
      .eq('id', poId)
      .eq('organization_id', orgId)
      .single()
    if (error || !data) throw new HttpException('Ordem não encontrada', 404)
    return data as { id: string; status: string }
  }

  async getOrders(orgId: string, filters: {
    status?: string; supplier_id?: string; date_from?: string; date_to?: string
  }) {
    let q = supabaseAdmin
      .from('purchase_orders')
      .select(PO_SELECT)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })

    if (filters.status)      q = q.eq('status', filters.status)
    if (filters.supplier_id) q = q.eq('supplier_id', filters.supplier_id)
    if (filters.date_from)   q = q.gte('expected_arrival_date', filters.date_from)
    if (filters.date_to)     q = q.lte('expected_arrival_date', filters.date_to)

    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }

  async getOrder(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin
      .from('purchase_orders')
      .select(PO_SELECT)
      .eq('id', id)
      .eq('organization_id', orgId)
      .single()
    if (error || !data) throw new HttpException('Ordem não encontrada', 404)
    return data
  }

  async createOrder(orgId: string, body: {
    supplier_id: string
    expected_arrival_date?: string
    currency?: string
    exchange_rate?: number
    incoterm?: string
    notes?: string
    internal_notes?: string
    freight_cost?: number
    other_costs?: number
    items: Array<{ product_id: string; quantity: number; unit_cost: number; expected_arrival_date?: string }>
  }) {
    // Generate PO number — try RPC first, fallback to counter
    let poNumber: string
    const year = new Date().getFullYear()
    try {
      const { data: rpcData } = await supabaseAdmin.rpc('fn_next_po_number', { p_org_id: orgId })
      poNumber = (rpcData as string) || ''
    } catch { poNumber = '' }

    if (!poNumber) {
      const { count } = await supabaseAdmin
        .from('purchase_orders')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', orgId)
        .gte('created_at', `${year}-01-01`)
      poNumber = `PO-${year}-${String((count ?? 0) + 1).padStart(4, '0')}`
    }

    const subtotal  = body.items.reduce((s, it) => s + it.quantity * it.unit_cost, 0)
    const totalCost = subtotal + (body.freight_cost ?? 0) + (body.other_costs ?? 0)

    const { data: po, error: poErr } = await supabaseAdmin
      .from('purchase_orders')
      .insert({
        organization_id:     orgId,
        po_number:            poNumber,
        supplier_id:          body.supplier_id,
        status:               'draft',
        expected_arrival_date: body.expected_arrival_date ?? null,
        currency:             body.currency ?? 'BRL',
        exchange_rate:        body.exchange_rate ?? 1,
        incoterm:             body.incoterm ?? null,
        notes:                body.notes ?? null,
        internal_notes:       body.internal_notes ?? null,
        freight_cost:         body.freight_cost ?? 0,
        other_costs:          body.other_costs ?? 0,
        subtotal,
        total_cost:           totalCost,
      })
      .select('id')
      .single()

    if (poErr || !po) throw new HttpException(poErr?.message ?? 'Erro ao criar PO', 500)

    if (body.items.length > 0) {
      const { error: itemErr } = await supabaseAdmin
        .from('purchase_order_items')
        .insert(body.items.map(it => ({
          purchase_order_id:     po.id,
          product_id:            it.product_id,
          quantity:              it.quantity,
          unit_cost:             it.unit_cost,
          subtotal:              it.quantity * it.unit_cost,
          quantity_received:     0,
          expected_arrival_date: it.expected_arrival_date ?? body.expected_arrival_date ?? null,
        })))
      if (itemErr) throw new HttpException(itemErr.message, 500)
    }

    return this.getOrder(orgId, po.id)
  }

  async updateOrder(orgId: string, id: string, body: Record<string, unknown>) {
    await this.assertOwnership(orgId, id)
    const ALLOWED = [
      'expected_arrival_date', 'currency', 'exchange_rate', 'incoterm', 'notes', 'internal_notes',
      'freight_cost', 'other_costs', 'tracking_number', 'carrier', 'container_number', 'bl_number',
    ]
    const patch: Record<string, unknown> = {}
    for (const k of ALLOWED) if (body[k] !== undefined) patch[k] = body[k]
    if (Object.keys(patch).length > 0) {
      const { error } = await supabaseAdmin.from('purchase_orders').update(patch).eq('id', id)
      if (error) throw new HttpException(error.message, 500)
    }
    return this.getOrder(orgId, id)
  }

  async updateStatus(orgId: string, id: string, newStatus: string) {
    const po = await this.assertOwnership(orgId, id)
    const current = po.status

    if (newStatus !== 'cancelled') {
      const allowed = STATUS_FLOW[current]
      if (allowed !== newStatus) throw new HttpException(`Transição inválida: ${current} → ${newStatus}`, 400)
    }

    const patch: Record<string, unknown> = { status: newStatus }
    if (newStatus === 'ordered')   patch.ordered_at = new Date().toISOString()

    const { error } = await supabaseAdmin.from('purchase_orders').update(patch).eq('id', id)
    if (error) throw new HttpException(error.message, 500)

    if (newStatus === 'received') await this.applyStockReceipt(id)

    return this.getOrder(orgId, id)
  }

  private async applyStockReceipt(poId: string) {
    const { data: items } = await supabaseAdmin
      .from('purchase_order_items')
      .select('product_id, quantity_received, quantity')
      .eq('purchase_order_id', poId)

    for (const item of items ?? []) {
      const qty = item.quantity_received > 0 ? item.quantity_received : item.quantity
      if (qty <= 0) continue

      const { data: existing } = await supabaseAdmin
        .from('product_stock')
        .select('id, quantity')
        .eq('product_id', item.product_id)
        .maybeSingle()

      if (existing) {
        await supabaseAdmin
          .from('product_stock')
          .update({ quantity: (existing.quantity ?? 0) + qty })
          .eq('id', existing.id)
      } else {
        await supabaseAdmin
          .from('product_stock')
          .insert({ product_id: item.product_id, quantity: qty })
      }
    }
  }

  async updateItem(orgId: string, poId: string, itemId: string, body: {
    quantity_received?: number; actual_arrival_date?: string
  }) {
    await this.assertOwnership(orgId, poId)
    const { error } = await supabaseAdmin
      .from('purchase_order_items')
      .update(body)
      .eq('id', itemId)
      .eq('purchase_order_id', poId)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  async deleteOrder(orgId: string, id: string) {
    const po = await this.assertOwnership(orgId, id)
    if (!['draft', 'cancelled'].includes(po.status))
      throw new HttpException('Só é possível excluir POs em rascunho ou canceladas', 400)
    await supabaseAdmin.from('purchase_order_items').delete().eq('purchase_order_id', id)
    const { error } = await supabaseAdmin.from('purchase_orders').delete().eq('id', id)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  async getTimeline(orgId: string) {
    const sixMonths = new Date(Date.now() + 180 * 86400000).toISOString()
    const { data, error } = await supabaseAdmin
      .from('purchase_orders')
      .select(`
        id, po_number, status, expected_arrival_date, ordered_at, total_cost, currency,
        suppliers(name, country),
        purchase_order_items(id, quantity, expected_arrival_date, products(name, sku))
      `)
      .eq('organization_id', orgId)
      .not('status', 'in', '("received","cancelled","draft")')
      .lte('expected_arrival_date', sixMonths)
      .order('expected_arrival_date', { ascending: true })
    if (error) throw new HttpException(error.message, 500)
    return data ?? []
  }
}
