import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'

export type ReturnItemCondition = 'pending' | 'restock' | 'damaged' | 'discard'

interface ReturnItem {
  sku: string
  product_id: string | null
  qty: number
  condition: ReturnItemCondition
  restocked: boolean
  title?: string | null
}

/**
 * F12 Sprint 5 — Devoluções. Registra a reentrada de um pedido devolvido,
 * a conferência item a item, e o reestoque no Estoque Unificado (itens OK).
 */
@Injectable()
export class FulfillmentReturnsService {
  private readonly logger = new Logger(FulfillmentReturnsService.name)

  constructor(private readonly stock: StockService) {}

  /** Registra uma devolução. Itens vêm explícitos OU são derivados do
   *  fulfillment_order (pick_tasks) quando só o pedido é informado. */
  async register(orgId: string, userId: string, input: {
    warehouseId?: string
    fulfillmentOrderId?: string
    reference?: string
    customer?: Record<string, unknown>
    reason?: string
    items?: Array<{ sku: string; productId?: string; qty: number; title?: string }>
  }): Promise<{ ok: true; id: string }> {
    let warehouseId = input.warehouseId ?? null
    let reference = input.reference ?? null
    let customer = input.customer ?? {}
    let rawItems = input.items ?? []

    // Deriva do fulfillment_order se não vierem itens
    if (input.fulfillmentOrderId && rawItems.length === 0) {
      const { data: fo } = await supabaseAdmin
        .from('fulfillment_orders').select('warehouse_id, reference, customer')
        .eq('id', input.fulfillmentOrderId).eq('organization_id', orgId).maybeSingle()
      if (!fo) throw new NotFoundException('Pedido de fulfillment não encontrado.')
      warehouseId = warehouseId ?? (fo as { warehouse_id: string | null }).warehouse_id
      reference = reference ?? (fo as { reference: string | null }).reference
      customer = Object.keys(customer).length ? customer : ((fo as { customer: Record<string, unknown> }).customer ?? {})
      const { data: tasks } = await supabaseAdmin
        .from('pick_tasks').select('sku, product_id, title, expected_qty')
        .eq('fulfillment_order_id', input.fulfillmentOrderId).eq('organization_id', orgId)
      rawItems = (tasks ?? []).map((t) => {
        const r = t as { sku: string; product_id: string | null; title: string | null; expected_qty: number }
        return { sku: r.sku, productId: r.product_id ?? undefined, qty: r.expected_qty, title: r.title ?? undefined }
      })
    }

    if (rawItems.length === 0) throw new BadRequestException('Informe os itens devolvidos (ou o pedido de origem).')

    // Resolve product_id por SKU pros itens sem id (pra permitir reestoque)
    const needSku = [...new Set(rawItems.filter((i) => !i.productId && i.sku).map((i) => i.sku))]
    const idBySku = new Map<string, string>()
    if (needSku.length > 0) {
      const { data: prods } = await supabaseAdmin
        .from('products').select('id, sku').eq('organization_id', orgId).in('sku', needSku)
      for (const p of (prods ?? []) as Array<{ id: string; sku: string }>) idBySku.set(p.sku, p.id)
    }

    const items: ReturnItem[] = rawItems.map((i) => ({
      sku: i.sku,
      product_id: i.productId ?? idBySku.get(i.sku) ?? null,
      qty: Math.max(1, Math.round(Number(i.qty) || 1)),
      condition: 'pending',
      restocked: false,
      title: i.title ?? null,
    }))

    const { data, error } = await supabaseAdmin
      .from('fulfillment_returns')
      .insert({
        organization_id: orgId,
        warehouse_id: warehouseId,
        fulfillment_order_id: input.fulfillmentOrderId ?? null,
        reference,
        customer,
        reason: input.reason ?? null,
        items,
        status: 'registered',
        created_by: userId,
      })
      .select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao registrar devolução: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }

  /** Resolve a devolução: define a condição de cada item (por SKU) e
   *  reestoca os que ficaram 'restock'. Idempotente no reestoque. */
  async resolve(orgId: string, userId: string, returnId: string, resolutions: Array<{ sku: string; condition: ReturnItemCondition }>): Promise<{ ok: true; restocked: number }> {
    const { data: ret } = await supabaseAdmin
      .from('fulfillment_returns').select('id, items, status')
      .eq('id', returnId).eq('organization_id', orgId).maybeSingle()
    if (!ret) throw new NotFoundException('Devolução não encontrada.')
    const items = ((ret as { items: ReturnItem[] }).items ?? [])
    const bySku = new Map(resolutions.map((r) => [r.sku, r.condition]))

    let restocked = 0
    for (const it of items) {
      const cond = bySku.get(it.sku)
      if (cond && ['restock', 'damaged', 'discard'].includes(cond)) it.condition = cond
      if (it.condition === 'restock' && !it.restocked && it.product_id) {
        const r = await this.stock.applyReturnRestock({ productId: it.product_id, quantity: it.qty, returnId })
        if (r === 'restocked') { it.restocked = true; restocked++ }
        else if (r === 'noop') { it.restocked = true } // já reestocado antes
      }
    }

    const allResolved = items.every((i) => i.condition !== 'pending')
    await supabaseAdmin
      .from('fulfillment_returns')
      .update({
        items,
        status: allResolved ? 'resolved' : 'inspecting',
        resolved_by: allResolved ? userId : null,
        resolved_at: allResolved ? new Date().toISOString() : null,
      })
      .eq('id', returnId).eq('organization_id', orgId)
    return { ok: true, restocked }
  }

  async list(orgId: string, warehouseId?: string) {
    let q = supabaseAdmin
      .from('fulfillment_returns').select('*')
      .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(200)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    const { data } = await q
    return data ?? []
  }

  async get(orgId: string, id: string) {
    const { data } = await supabaseAdmin
      .from('fulfillment_returns').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Devolução não encontrada.')
    return data
  }
}
