import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export type PickProfile = 'single' | 'mono_multi' | 'multi'

export interface PickingCart {
  id: string
  warehouse_id: string | null
  name: string
  width_cm: number
  length_cm: number
  height_cm: number
  fill_factor: number
  is_active: boolean
}

/** Perfil de quantidade do pedido (define o método de coleta).
 *  single = 1 item × 1 un · mono_multi = 1 SKU × N un · multi = 2+ itens. */
export function computePickProfile(items: Array<{ qty: number }>): PickProfile {
  if (items.length <= 1) {
    const q = items[0]?.qty ?? 1
    return q > 1 ? 'mono_multi' : 'single'
  }
  return 'multi'
}

/**
 * Carrinho de coleta (cubagem) + perfil de separação + tela de medição.
 * SÓ volume cúbico — peso não entra (produtos leves, carrinho pequeno).
 */
@Injectable()
export class FulfillmentCartsService {
  private readonly logger = new Logger(FulfillmentCartsService.name)

  /** Volume ÚTIL do carrinho (cm³) = L×C×A × fator de aproveitamento. */
  private usableVolume(c: { width_cm: number; length_cm: number; height_cm: number; fill_factor: number }): number {
    return Number(c.width_cm) * Number(c.length_cm) * Number(c.height_cm) * Number(c.fill_factor)
  }

  // ── CRUD de carrinhos ────────────────────────────────────────────────────────
  async listCarts(orgId: string, warehouseId?: string): Promise<Array<PickingCart & { usable_volume_cm3: number }>> {
    let q = supabaseAdmin.from('picking_carts').select('*').eq('organization_id', orgId)
    if (warehouseId) q = q.or(`warehouse_id.eq.${warehouseId},warehouse_id.is.null`)
    const { data } = await q.order('created_at', { ascending: true })
    return ((data ?? []) as PickingCart[]).map((c) => ({ ...c, usable_volume_cm3: Math.round(this.usableVolume(c)) }))
  }

  async createCart(orgId: string, input: { warehouseId?: string | null; name: string; width_cm: number; length_cm: number; height_cm: number; fill_factor?: number }): Promise<{ ok: true; id: string }> {
    const name = (input.name ?? '').trim()
    if (!name) throw new BadRequestException('Informe o nome do carrinho.')
    const w = Number(input.width_cm), l = Number(input.length_cm), h = Number(input.height_cm)
    if (!(w > 0 && l > 0 && h > 0)) throw new BadRequestException('Informe as medidas internas (L×C×A) em cm.')
    const ff = input.fill_factor != null ? Math.min(Math.max(Number(input.fill_factor), 0.1), 1) : 0.75
    const { data, error } = await supabaseAdmin.from('picking_carts')
      .insert({ organization_id: orgId, warehouse_id: input.warehouseId ?? null, name, width_cm: w, length_cm: l, height_cm: h, fill_factor: ff })
      .select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar carrinho: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }

  async updateCart(orgId: string, id: string, patch: { name?: string; width_cm?: number; length_cm?: number; height_cm?: number; fill_factor?: number; is_active?: boolean }): Promise<{ ok: true }> {
    const row: Record<string, unknown> = {}
    if (patch.name !== undefined) row.name = String(patch.name).trim()
    if (patch.width_cm !== undefined) row.width_cm = Number(patch.width_cm)
    if (patch.length_cm !== undefined) row.length_cm = Number(patch.length_cm)
    if (patch.height_cm !== undefined) row.height_cm = Number(patch.height_cm)
    if (patch.fill_factor !== undefined) row.fill_factor = Math.min(Math.max(Number(patch.fill_factor), 0.1), 1)
    if (patch.is_active !== undefined) row.is_active = patch.is_active
    if (Object.keys(row).length) {
      const { error } = await supabaseAdmin.from('picking_carts').update(row).eq('id', id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar carrinho: ${error.message}`)
    }
    return { ok: true }
  }

  async deleteCart(orgId: string, id: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('picking_carts').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao remover carrinho: ${error.message}`)
    return { ok: true }
  }

  // ── Medição de produtos (tela de medição: bipar + digitar) ───────────────────
  /** Produtos que precisam de medida (estão na fila de coleta e sem L×C×A). */
  async productsToMeasure(orgId: string, warehouseId?: string): Promise<Array<{ productId: string | null; sku: string; title: string | null }>> {
    let q = supabaseAdmin.from('pick_tasks').select('product_id, sku, title')
      .eq('organization_id', orgId).in('status', ['pending', 'in_progress'])
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    const { data: tasks } = await q.limit(2000)
    const bySku = new Map<string, { productId: string | null; sku: string; title: string | null }>()
    for (const t of (tasks ?? []) as Array<{ product_id: string | null; sku: string; title: string | null }>) {
      if (!bySku.has(t.sku)) bySku.set(t.sku, { productId: t.product_id, sku: t.sku, title: t.title })
    }
    const skus = [...bySku.keys()]
    if (skus.length === 0) return []
    const measured = new Set<string>()
    for (let i = 0; i < skus.length; i += 300) {
      const { data } = await supabaseAdmin.from('products').select('sku, width_cm, length_cm, height_cm')
        .eq('organization_id', orgId).in('sku', skus.slice(i, i + 300))
      for (const p of (data ?? []) as Array<{ sku: string; width_cm: number | null; length_cm: number | null; height_cm: number | null }>) {
        if (p.width_cm && p.length_cm && p.height_cm) measured.add(p.sku)
      }
    }
    return [...bySku.values()].filter((p) => !measured.has(p.sku))
  }

  /** Grava as medidas de um produto (por SKU ou productId). */
  async measureProduct(orgId: string, input: { productId?: string; sku?: string; width_cm: number; length_cm: number; height_cm: number }): Promise<{ ok: true; sku: string | null }> {
    const w = Number(input.width_cm), l = Number(input.length_cm), h = Number(input.height_cm)
    if (!(w > 0 && l > 0 && h > 0)) throw new BadRequestException('Informe L×C×A (cm) maiores que zero.')
    let q = supabaseAdmin.from('products').update({ width_cm: w, length_cm: l, height_cm: h, updated_at: new Date().toISOString() }).eq('organization_id', orgId)
    if (input.productId) q = q.eq('id', input.productId)
    else if (input.sku) q = q.eq('sku', input.sku)
    else throw new BadRequestException('Informe o produto (productId ou sku).')
    const { data, error } = await q.select('sku')
    if (error) throw new BadRequestException(`Erro ao salvar medidas: ${error.message}`)
    const sku = (data as Array<{ sku: string | null }> | null)?.[0]?.sku ?? input.sku ?? null
    return { ok: true, sku }
  }

  // ── Plano de carrinhos da onda (greedy ao longo da rota) ─────────────────────
  /** Volume (cm³) por SKU a partir das medidas do catálogo; null = sem medida. */
  private async productVolumesBySku(orgId: string, skus: string[]): Promise<Map<string, number | null>> {
    const map = new Map<string, number | null>()
    const unique = [...new Set(skus.filter(Boolean))]
    for (let i = 0; i < unique.length; i += 300) {
      const { data } = await supabaseAdmin.from('products').select('sku, width_cm, length_cm, height_cm')
        .eq('organization_id', orgId).in('sku', unique.slice(i, i + 300))
      for (const p of (data ?? []) as Array<{ sku: string; width_cm: number | null; length_cm: number | null; height_cm: number | null }>) {
        const v = (p.width_cm && p.length_cm && p.height_cm) ? Number(p.width_cm) * Number(p.length_cm) * Number(p.height_cm) : null
        if (!map.has(p.sku)) map.set(p.sku, v)
      }
    }
    return map
  }

  /** Planeja os carrinhos de uma onda: caminha a rota (endereço) somando volume; ao
   *  estourar o volume útil do carrinho, abre o próximo. Itens sem medida ficam de fora
   *  (lista "a medir"). Grava cart_id + cart_plan na onda. */
  async planWaveCarts(orgId: string, waveId: string, cartId: string): Promise<{ ok: true; carts: number; toMeasure: number; plan: unknown }> {
    const { data: cart } = await supabaseAdmin.from('picking_carts').select('*').eq('id', cartId).eq('organization_id', orgId).maybeSingle()
    if (!cart) throw new NotFoundException('Carrinho não encontrado.')
    const cap = this.usableVolume(cart as PickingCart)

    // pedidos da onda → pick_tasks consolidados por SKU, ordenados pela ROTA
    const { data: links } = await supabaseAdmin.from('fulfillment_wave_orders').select('fulfillment_order_id').eq('organization_id', orgId).eq('wave_id', waveId)
    const foIds = (links ?? []).map((r) => (r as { fulfillment_order_id: string }).fulfillment_order_id)
    if (foIds.length === 0) throw new BadRequestException('Onda sem pedidos.')
    const { data: tasks } = await supabaseAdmin.from('pick_tasks').select('sku, title, expected_qty, location_code, location_seq').eq('organization_id', orgId).in('fulfillment_order_id', foIds)
    const bySku = new Map<string, { sku: string; title: string | null; qty: number; locationCode: string | null; seq: number }>()
    for (const t of (tasks ?? []) as Array<{ sku: string; title: string | null; expected_qty: number; location_code: string | null; location_seq: number | null }>) {
      const e = bySku.get(t.sku) ?? { sku: t.sku, title: t.title, qty: 0, locationCode: t.location_code, seq: t.location_seq ?? Number.MAX_SAFE_INTEGER }
      e.qty += t.expected_qty
      if (t.location_seq != null && t.location_seq < e.seq) { e.seq = t.location_seq; e.locationCode = t.location_code }
      bySku.set(t.sku, e)
    }
    const lines = [...bySku.values()].sort((a, b) => a.seq - b.seq)
    const vols = await this.productVolumesBySku(orgId, lines.map((l) => l.sku))

    const carts: Array<{ index: number; volumeUsed: number; volumeCap: number; items: Array<{ sku: string; title: string | null; qty: number; locationCode: string | null }> }> = []
    const toMeasure: Array<{ sku: string; title: string | null }> = []
    let cur = { index: 1, volumeUsed: 0, volumeCap: Math.round(cap), items: [] as Array<{ sku: string; title: string | null; qty: number; locationCode: string | null }> }
    for (const ln of lines) {
      const unit = vols.get(ln.sku)
      if (unit == null) { toMeasure.push({ sku: ln.sku, title: ln.title }); continue }
      const lineVol = unit * ln.qty
      // abre novo carrinho se estourar (e o atual já tem item); item maior que o carrinho fica sozinho
      if (cur.items.length > 0 && cur.volumeUsed + lineVol > cap) {
        carts.push(cur)
        cur = { index: cur.index + 1, volumeUsed: 0, volumeCap: Math.round(cap), items: [] }
      }
      cur.items.push({ sku: ln.sku, title: ln.title, qty: ln.qty, locationCode: ln.locationCode })
      cur.volumeUsed = Math.round(cur.volumeUsed + lineVol)
    }
    if (cur.items.length > 0) carts.push(cur)

    const plan = { cartName: (cart as PickingCart).name, capacity: Math.round(cap), carts, toMeasure, generatedAt: null as string | null }
    await supabaseAdmin.from('fulfillment_waves').update({ cart_id: cartId, cart_plan: plan }).eq('id', waveId).eq('organization_id', orgId)
    return { ok: true, carts: carts.length, toMeasure: toMeasure.length, plan }
  }
}
