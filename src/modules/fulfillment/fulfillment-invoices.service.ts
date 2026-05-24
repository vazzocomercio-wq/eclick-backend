import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

export type InvoiceKind = 'venda' | 'transferencia' | 'devolucao' | 'outra'
export type InvoiceStatus = 'draft' | 'issued' | 'cancelled'

export interface InvoiceItem { sku: string; description?: string | null; qty: number; unit_value?: number | null }
export interface ValidationDiffRow { sku: string; invoiceQty: number; pickedQty: number; ok: boolean }

/**
 * F12 Onda D — NF-e (PREPARAÇÃO, não emite ainda) + validação de conferência fiscal.
 *
 * Guarda os dados da nota por pedido (aceita várias por pedido p/ o dropship
 * triangular futuro) e VALIDA que os itens da nota batem com o que foi SEPARADO
 * (pick_tasks.picked_qty por SKU) — a trava antes de liberar a coleta.
 * A emissão de verdade (provedor) virá numa onda futura.
 */
@Injectable()
export class FulfillmentInvoicesService {
  private readonly logger = new Logger(FulfillmentInvoicesService.name)

  async listForOrder(orgId: string, fulfillmentOrderId: string) {
    const { data } = await supabaseAdmin
      .from('fulfillment_invoices').select('*')
      .eq('organization_id', orgId).eq('fulfillment_order_id', fulfillmentOrderId)
      .order('created_at', { ascending: true })
    return data ?? []
  }

  /** Itens separados (picked_qty) por SKU do pedido. */
  private async pickedBySku(orgId: string, fulfillmentOrderId: string): Promise<Map<string, number>> {
    const { data } = await supabaseAdmin
      .from('pick_tasks').select('sku, picked_qty, expected_qty, status')
      .eq('organization_id', orgId).eq('fulfillment_order_id', fulfillmentOrderId).neq('status', 'cancelled')
    const map = new Map<string, number>()
    for (const r of (data ?? []) as Array<{ sku: string; picked_qty: number | null }>) {
      map.set(r.sku, (map.get(r.sku) ?? 0) + (Number(r.picked_qty) || 0))
    }
    return map
  }

  /** Itens ESPERADOS por SKU (fallback p/ rascunho de nota sem itens). */
  private async expectedItems(orgId: string, fulfillmentOrderId: string): Promise<InvoiceItem[]> {
    const { data } = await supabaseAdmin
      .from('pick_tasks').select('sku, title, expected_qty')
      .eq('organization_id', orgId).eq('fulfillment_order_id', fulfillmentOrderId).neq('status', 'cancelled')
    const bySku = new Map<string, InvoiceItem>()
    for (const r of (data ?? []) as Array<{ sku: string; title: string | null; expected_qty: number }>) {
      const e = bySku.get(r.sku) ?? { sku: r.sku, description: r.title, qty: 0 }
      e.qty += Number(r.expected_qty) || 0
      bySku.set(r.sku, e)
    }
    return [...bySku.values()]
  }

  async upsertForOrder(orgId: string, fulfillmentOrderId: string, input: {
    id?: string; companyId?: string | null; kind?: InvoiceKind; status?: InvoiceStatus
    number?: string | null; series?: string | null; accessKey?: string | null
    danfeUrl?: string | null; xmlUrl?: string | null; provider?: string | null
    items?: InvoiceItem[]
  }): Promise<{ ok: true; id: string }> {
    // confirma que o pedido é da org
    const { data: fo } = await supabaseAdmin
      .from('fulfillment_orders').select('id, company_id').eq('id', fulfillmentOrderId).eq('organization_id', orgId).maybeSingle()
    if (!fo) throw new NotFoundException('Pedido não encontrado.')

    const items = input.items ?? (input.id ? undefined : await this.expectedItems(orgId, fulfillmentOrderId))
    const row: Record<string, unknown> = {}
    if (input.companyId !== undefined) row.company_id = input.companyId
    if (input.kind !== undefined) row.kind = input.kind
    if (input.status !== undefined) row.status = input.status
    if (input.number !== undefined) row.number = input.number
    if (input.series !== undefined) row.series = input.series
    if (input.accessKey !== undefined) row.access_key = normalizeKey(input.accessKey)
    if (input.danfeUrl !== undefined) row.danfe_url = input.danfeUrl
    if (input.xmlUrl !== undefined) row.xml_url = input.xmlUrl
    if (input.provider !== undefined) row.provider = input.provider
    if (items !== undefined) row.items = items

    if (input.id) {
      const { error } = await supabaseAdmin.from('fulfillment_invoices').update(row).eq('id', input.id).eq('organization_id', orgId)
      if (error) throw new BadRequestException(`Erro ao atualizar NF-e: ${error.message}`)
      return { ok: true, id: input.id }
    }
    const { data, error } = await supabaseAdmin
      .from('fulfillment_invoices')
      .insert({
        organization_id: orgId, fulfillment_order_id: fulfillmentOrderId,
        company_id: (row.company_id as string | null | undefined) ?? (fo as { company_id: string | null }).company_id,
        ...row,
      })
      .select('id').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar NF-e: ${error?.message ?? '?'}`)
    return { ok: true, id: (data as { id: string }).id }
  }

  /** Compara os itens da nota × separado e grava o resultado. Trava de conferência fiscal. */
  async validate(orgId: string, invoiceId: string): Promise<{ status: 'match' | 'mismatch'; diff: ValidationDiffRow[] }> {
    const { data: inv } = await supabaseAdmin
      .from('fulfillment_invoices').select('id, fulfillment_order_id, items').eq('id', invoiceId).eq('organization_id', orgId).maybeSingle()
    if (!inv) throw new NotFoundException('NF-e não encontrada.')
    const invoice = inv as { id: string; fulfillment_order_id: string; items: InvoiceItem[] }
    const picked = await this.pickedBySku(orgId, invoice.fulfillment_order_id)

    const invBySku = new Map<string, number>()
    for (const it of invoice.items ?? []) invBySku.set(normalize(it.sku), (invBySku.get(normalize(it.sku)) ?? 0) + (Number(it.qty) || 0))
    const pickedNorm = new Map<string, number>()
    for (const [sku, q] of picked) pickedNorm.set(normalize(sku), (pickedNorm.get(normalize(sku)) ?? 0) + q)

    const allSkus = new Set<string>([...invBySku.keys(), ...pickedNorm.keys()])
    const diff: ValidationDiffRow[] = []
    let mismatch = false
    for (const sku of allSkus) {
      const invoiceQty = invBySku.get(sku) ?? 0
      const pickedQty = pickedNorm.get(sku) ?? 0
      const ok = invoiceQty === pickedQty
      if (!ok) mismatch = true
      diff.push({ sku, invoiceQty, pickedQty, ok })
    }
    const status = mismatch ? 'mismatch' : 'match'
    await supabaseAdmin.from('fulfillment_invoices')
      .update({ validation_status: status, validation_diff: diff, validated_at: new Date().toISOString() })
      .eq('id', invoiceId).eq('organization_id', orgId)
    return { status, diff }
  }

  async remove(orgId: string, invoiceId: string): Promise<{ ok: true }> {
    const { error } = await supabaseAdmin.from('fulfillment_invoices').delete().eq('id', invoiceId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao remover NF-e: ${error.message}`)
    return { ok: true }
  }
}

function normalize(s: string): string { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, '') }
function normalizeKey(k: string | null | undefined): string | null {
  if (!k) return null
  const d = String(k).replace(/\D/g, '')
  return d.length > 0 ? d : null
}
