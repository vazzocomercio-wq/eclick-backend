import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { LlmService } from '../ai/llm.service'

/**
 * e-Click Wave IA — separação em ondas (wave picking).
 *
 * Formação MANUAL + IA assistiva: o supervisor escolhe os pedidos e a IA
 * sugere quais adicionar/remover (SKU em comum, mesma transportadora, SLA).
 * Coleta CONSOLIDADA (todos os itens da onda agrupados por SKU, 1 rota) +
 * SORTING (distribui o coletado de volta em cada pedido → vira pack normal).
 */
@Injectable()
export class FulfillmentWaveService {
  private readonly logger = new Logger(FulfillmentWaveService.name)

  constructor(private readonly llm: LlmService) {}

  // ── helpers ───────────────────────────────────────────────────────────
  private async orderIdsOfWave(orgId: string, waveId: string): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from('fulfillment_wave_orders').select('fulfillment_order_id')
      .eq('organization_id', orgId).eq('wave_id', waveId)
    return (data ?? []).map((r) => (r as { fulfillment_order_id: string }).fulfillment_order_id)
  }

  private async ordersInfo(orgId: string, foIds: string[]): Promise<Map<string, { reference: string | null; channel: string | null; sla_deadline: string | null }>> {
    const map = new Map<string, { reference: string | null; channel: string | null; sla_deadline: string | null }>()
    if (foIds.length === 0) return map
    const { data } = await supabaseAdmin
      .from('fulfillment_orders').select('id, reference, channel, sla_deadline')
      .eq('organization_id', orgId).in('id', foIds)
    for (const r of (data ?? []) as Array<{ id: string; reference: string | null; channel: string | null; sla_deadline: string | null }>) map.set(r.id, r)
    return map
  }

  private async pickTasksOf(orgId: string, foIds: string[]) {
    if (foIds.length === 0) return [] as Array<{ fulfillment_order_id: string; sku: string; title: string | null; expected_qty: number; expected_barcode: string | null; status: string }>
    const { data } = await supabaseAdmin
      .from('pick_tasks').select('fulfillment_order_id, sku, title, expected_qty, expected_barcode, status')
      .eq('organization_id', orgId).in('fulfillment_order_id', foIds)
    return (data ?? []) as Array<{ fulfillment_order_id: string; sku: string; title: string | null; expected_qty: number; expected_barcode: string | null; status: string }>
  }

  /** Lista consolidada (por SKU) de uma onda: total a coletar × coletado × por-pedido. */
  async consolidatedList(orgId: string, waveId: string, collected: Record<string, number> = {}) {
    const foIds = await this.orderIdsOfWave(orgId, waveId)
    const tasks = await this.pickTasksOf(orgId, foIds)
    const refs = await this.ordersInfo(orgId, foIds)
    const bySku = new Map<string, { sku: string; title: string | null; expected_barcode: string | null; totalQty: number; perOrder: Array<{ foId: string; ref: string | null; qty: number }> }>()
    for (const t of tasks) {
      const e = bySku.get(t.sku) ?? { sku: t.sku, title: t.title, expected_barcode: t.expected_barcode, totalQty: 0, perOrder: [] }
      e.totalQty += t.expected_qty
      e.perOrder.push({ foId: t.fulfillment_order_id, ref: refs.get(t.fulfillment_order_id)?.reference ?? null, qty: t.expected_qty })
      if (!e.expected_barcode && t.expected_barcode) e.expected_barcode = t.expected_barcode
      bySku.set(t.sku, e)
    }
    return [...bySku.values()].map((e) => ({ ...e, collectedQty: collected[e.sku] ?? 0 }))
  }

  // ── CRUD / fluxo ────────────────────────────────────────────────────────
  async listWaves(orgId: string, warehouseId?: string) {
    let q = supabaseAdmin.from('fulfillment_waves').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    const { data } = await q
    const waves = (data ?? []) as Array<Record<string, unknown>>
    // contagem de pedidos por onda
    const ids = waves.map((w) => w.id as string)
    const counts = new Map<string, number>()
    if (ids.length > 0) {
      const { data: links } = await supabaseAdmin.from('fulfillment_wave_orders').select('wave_id').in('wave_id', ids)
      for (const l of (links ?? []) as Array<{ wave_id: string }>) counts.set(l.wave_id, (counts.get(l.wave_id) ?? 0) + 1)
    }
    return waves.map((w) => ({ ...w, orders_count: counts.get(w.id as string) ?? 0 }))
  }

  async getWave(orgId: string, id: string) {
    const { data: wave } = await supabaseAdmin.from('fulfillment_waves').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!wave) throw new NotFoundException('Onda não encontrada.')
    const w = wave as Record<string, unknown>
    const { data: links } = await supabaseAdmin.from('fulfillment_wave_orders').select('fulfillment_order_id, sorted').eq('wave_id', id).eq('organization_id', orgId)
    const foIds = (links ?? []).map((l) => (l as { fulfillment_order_id: string }).fulfillment_order_id)
    const refs = await this.ordersInfo(orgId, foIds)
    const orders = (links ?? []).map((l) => {
      const r = l as { fulfillment_order_id: string; sorted: boolean }
      return { fulfillmentOrderId: r.fulfillment_order_id, sorted: r.sorted, reference: refs.get(r.fulfillment_order_id)?.reference ?? null, channel: refs.get(r.fulfillment_order_id)?.channel ?? null }
    })
    const consolidated = await this.consolidatedList(orgId, id, (w.collected as Record<string, number>) ?? {})
    return { ...w, orders, consolidated }
  }

  async createWave(orgId: string, userId: string, input: { warehouseId?: string; name?: string; fulfillmentOrderIds: string[] }) {
    const foIds = [...new Set(input.fulfillmentOrderIds ?? [])]
    if (foIds.length === 0) throw new BadRequestException('Selecione ao menos 1 pedido pra montar a onda.')
    // valida: pedidos da org, separáveis, fora de onda ativa
    const { data: fos } = await supabaseAdmin
      .from('fulfillment_orders').select('id, warehouse_id, status').eq('organization_id', orgId).in('id', foIds)
    const valid = (fos ?? []) as Array<{ id: string; warehouse_id: string | null; status: string }>
    if (valid.length !== foIds.length) throw new BadRequestException('Algum pedido não é da sua organização.')
    const notSeparable = valid.filter((f) => !['received', 'picking'].includes(f.status))
    if (notSeparable.length > 0) throw new BadRequestException(`${notSeparable.length} pedido(s) não estão em separação (já fechados/cancelados).`)
    const { data: already } = await supabaseAdmin
      .from('fulfillment_wave_orders').select('fulfillment_order_id, fulfillment_waves!inner(status)')
      .eq('organization_id', orgId).in('fulfillment_order_id', foIds)
    const inActive = (already ?? []).filter((a) => {
      const wv = (a as { fulfillment_waves?: { status?: string } | { status?: string }[] }).fulfillment_waves
      const st = Array.isArray(wv) ? wv[0]?.status : wv?.status
      return st && st !== 'done' && st !== 'cancelled'
    })
    if (inActive.length > 0) throw new BadRequestException(`${inActive.length} pedido(s) já estão em outra onda ativa.`)

    const warehouseId = input.warehouseId ?? valid[0].warehouse_id
    const { data: wave, error } = await supabaseAdmin
      .from('fulfillment_waves')
      .insert({ organization_id: orgId, warehouse_id: warehouseId, name: input.name ?? null, status: 'open', created_by: userId })
      .select('id').maybeSingle()
    if (error || !wave) throw new BadRequestException(`Erro ao criar onda: ${error?.message ?? '?'}`)
    const waveId = (wave as { id: string }).id
    const rows = foIds.map((fo) => ({ organization_id: orgId, wave_id: waveId, fulfillment_order_id: fo }))
    const { error: linkErr } = await supabaseAdmin.from('fulfillment_wave_orders').insert(rows)
    if (linkErr) throw new BadRequestException(`Erro ao vincular pedidos: ${linkErr.message}`)
    return { ok: true, id: waveId, orders: foIds.length }
  }

  /** IA assistiva: sugere pedidos a ADICIONAR (SKU em comum, mesma transportadora,
   *  SLA próximo) e AVISA sobre selecionados que destoam. Heurística + rationale LLM (best-effort). */
  async suggestForWave(orgId: string, warehouseId: string | undefined, selectedIds: string[]) {
    const sel = [...new Set(selectedIds ?? [])]
    // SKUs + canais da seleção
    const selTasks = await this.pickTasksOf(orgId, sel)
    const selSkus = new Set(selTasks.map((t) => t.sku))
    const selInfo = await this.ordersInfo(orgId, sel)
    const channelCount = new Map<string, number>()
    for (const i of selInfo.values()) if (i.channel) channelCount.set(i.channel, (channelCount.get(i.channel) ?? 0) + 1)
    const majorityChannel = [...channelCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    // pool: pendentes, fora da seleção, fora de onda ativa
    let poolQ = supabaseAdmin.from('fulfillment_orders').select('id, reference, channel, sla_deadline')
      .eq('organization_id', orgId).in('status', ['received', 'picking']).limit(200)
    if (warehouseId) poolQ = poolQ.eq('warehouse_id', warehouseId)
    const { data: pool } = await poolQ
    const poolOrders = ((pool ?? []) as Array<{ id: string; reference: string | null; channel: string | null; sla_deadline: string | null }>).filter((o) => !sel.includes(o.id))
    const { data: inWaves } = await supabaseAdmin
      .from('fulfillment_wave_orders').select('fulfillment_order_id, fulfillment_waves!inner(status)').eq('organization_id', orgId)
    const lockedFo = new Set((inWaves ?? []).filter((a) => {
      const wv = (a as { fulfillment_waves?: { status?: string } | { status?: string }[] }).fulfillment_waves
      const st = Array.isArray(wv) ? wv[0]?.status : wv?.status
      return st && st !== 'done' && st !== 'cancelled'
    }).map((a) => (a as { fulfillment_order_id: string }).fulfillment_order_id))
    const candidates = poolOrders.filter((o) => !lockedFo.has(o.id))

    // tasks dos candidatos pra medir overlap de SKU
    const candTasks = await this.pickTasksOf(orgId, candidates.map((c) => c.id))
    const skusByFo = new Map<string, Set<string>>()
    for (const t of candTasks) {
      const s = skusByFo.get(t.fulfillment_order_id) ?? new Set<string>()
      s.add(t.sku); skusByFo.set(t.fulfillment_order_id, s)
    }
    const now = Date.now()
    const scored = candidates.map((o) => {
      const skus = skusByFo.get(o.id) ?? new Set<string>()
      const shared = [...skus].filter((s) => selSkus.has(s)).length
      const sameChannel = majorityChannel && o.channel === majorityChannel
      const slaSoon = o.sla_deadline && (new Date(o.sla_deadline).getTime() - now) < 24 * 3600_000
      const score = shared * 3 + (sameChannel ? 2 : 0) + (slaSoon ? 1 : 0)
      const reasons: string[] = []
      if (shared > 0) reasons.push(`${shared} SKU(s) em comum`)
      if (sameChannel) reasons.push(`mesma origem (${o.channel})`)
      if (slaSoon) reasons.push('SLA vencendo')
      return { foId: o.id, reference: o.reference, channel: o.channel, score, reason: reasons.join(' · ') || 'sem afinidade clara' }
    }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 6)

    // avisos: selecionados que destoam do canal majoritário
    const warnings = [...selInfo.entries()]
      .filter(([, i]) => majorityChannel && i.channel && i.channel !== majorityChannel)
      .map(([id, i]) => ({ foId: id, reference: i.reference, reason: `origem diferente (${i.channel}) — talvez separar em outra onda` }))

    // rationale LLM (best-effort, não bloqueia)
    let rationale: string | null = null
    try {
      if (sel.length > 0 || scored.length > 0) {
        const out = await this.llm.generateText({
          orgId, feature: 'fulfillment_wave_suggest', maxTokens: 200,
          systemPrompt: 'Você ajuda a montar ondas de separação num CD. Em 1-2 frases curtas em pt-BR, diga por que agrupar esses pedidos é eficiente (SKUs em comum, mesma transportadora, prazo). Seja direto, sem listar.',
          userPrompt: `Seleção atual: ${sel.length} pedido(s), canal majoritário: ${majorityChannel ?? '—'}. Sugestões de adição: ${scored.map((s) => s.reason).join('; ') || 'nenhuma'}.`,
        })
        rationale = out.text?.trim() || null
      }
    } catch (e) { this.logger.warn(`[wave-suggest] rationale LLM falhou: ${(e as Error).message}`) }

    return { majorityChannel, suggestions: scored, warnings, rationale }
  }

  async releaseWave(orgId: string, userId: string, id: string) {
    const { data: wave } = await supabaseAdmin.from('fulfillment_waves').select('status').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!wave) throw new NotFoundException('Onda não encontrada.')
    if ((wave as { status: string }).status !== 'open') throw new BadRequestException('Onda já foi liberada.')
    const foIds = await this.orderIdsOfWave(orgId, id)
    if (foIds.length === 0) throw new BadRequestException('Onda sem pedidos.')
    await supabaseAdmin.from('fulfillment_waves').update({ status: 'collecting', released_at: new Date().toISOString(), assigned_to: userId }).eq('id', id).eq('organization_id', orgId)
    await supabaseAdmin.from('fulfillment_orders').update({ status: 'picking' }).in('id', foIds).eq('organization_id', orgId).eq('status', 'received')
    return this.getWave(orgId, id)
  }

  /** Coleta consolidada: bipa um SKU/EAN da onda; conta o coletado. */
  async scanWaveItem(orgId: string, userId: string, id: string, code: string) {
    const { data: wave } = await supabaseAdmin.from('fulfillment_waves').select('status, collected, warehouse_id').eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (!wave) throw new NotFoundException('Onda não encontrada.')
    const w = wave as { status: string; collected: Record<string, number>; warehouse_id: string | null }
    if (!['collecting', 'sorting'].includes(w.status)) throw new BadRequestException('Onda não está em coleta.')
    const list = await this.consolidatedList(orgId, id, w.collected ?? {})
    const item = list.find((l) => normalize(l.sku) === normalize(code) || (l.expected_barcode && normalize(l.expected_barcode) === normalize(code)))
    if (!item) {
      await logAction(orgId, userId, 'scan_mismatch', { warehouseId: w.warehouse_id, payload: { wave: id, scanned: code } })
      throw new BadRequestException('Código não pertence a nenhum item desta onda.')
    }
    const collected = { ...(w.collected ?? {}) }
    const cur = collected[item.sku] ?? 0
    if (cur >= item.totalQty) throw new BadRequestException(`Já coletou tudo de ${item.sku} (${item.totalQty}).`)
    collected[item.sku] = cur + 1
    await supabaseAdmin.from('fulfillment_waves').update({ collected }).eq('id', id).eq('organization_id', orgId)
    await logAction(orgId, userId, 'scan_item', { warehouseId: w.warehouse_id, payload: { wave: id, sku: item.sku, collected: collected[item.sku] } })
    const allDone = list.every((l) => (l.sku === item.sku ? collected[item.sku] : (collected[l.sku] ?? 0)) >= l.totalQty)
    return { ok: true, sku: item.sku, collected: collected[item.sku], total: item.totalQty, allCollected: allDone }
  }

  /** Sorting: marca os itens de UM pedido como separados (→ vira pack normal). */
  async completeOrderInWave(orgId: string, userId: string, id: string, fulfillmentOrderId: string) {
    const { data: link } = await supabaseAdmin.from('fulfillment_wave_orders').select('id, sorted').eq('wave_id', id).eq('fulfillment_order_id', fulfillmentOrderId).eq('organization_id', orgId).maybeSingle()
    if (!link) throw new NotFoundException('Pedido não está nesta onda.')
    if ((link as { sorted: boolean }).sorted) return { ok: true, alreadySorted: true }
    // marca pick_tasks do pedido como picked → trigger promove pro pack
    const { data: tasks } = await supabaseAdmin.from('pick_tasks').select('id, expected_qty, warehouse_id').eq('fulfillment_order_id', fulfillmentOrderId).eq('organization_id', orgId).neq('status', 'cancelled')
    for (const t of (tasks ?? []) as Array<{ id: string; expected_qty: number }>) {
      await supabaseAdmin.from('pick_tasks').update({ status: 'picked', picked_qty: t.expected_qty, picked_at: new Date().toISOString(), picked_by: userId }).eq('id', t.id)
    }
    await supabaseAdmin.from('fulfillment_wave_orders').update({ sorted: true }).eq('id', (link as { id: string }).id)
    await logAction(orgId, userId, 'pick_complete', { fulfillmentOrderId, payload: { wave: id } })
    // se todos sorted → onda done
    const { data: links } = await supabaseAdmin.from('fulfillment_wave_orders').select('sorted').eq('wave_id', id).eq('organization_id', orgId)
    const allSorted = (links ?? []).every((l) => (l as { sorted: boolean }).sorted)
    if (allSorted) await supabaseAdmin.from('fulfillment_waves').update({ status: 'done', closed_at: new Date().toISOString() }).eq('id', id).eq('organization_id', orgId)
    else await supabaseAdmin.from('fulfillment_waves').update({ status: 'sorting' }).eq('id', id).eq('organization_id', orgId).eq('status', 'collecting')
    return { ok: true, allSorted }
  }

  async cancelWave(orgId: string, id: string) {
    await supabaseAdmin.from('fulfillment_waves').update({ status: 'cancelled', closed_at: new Date().toISOString() }).eq('id', id).eq('organization_id', orgId)
    return { ok: true }
  }
}

function normalize(s: string): string { return String(s ?? '').trim().toUpperCase().replace(/\s+/g, '') }

async function logAction(orgId: string, userId: string, actionType: string, opts: { warehouseId?: string | null; fulfillmentOrderId?: string; payload?: Record<string, unknown> }) {
  try {
    await supabaseAdmin.from('operator_actions').insert({
      organization_id: orgId, user_id: userId, warehouse_id: opts.warehouseId ?? null,
      action_type: actionType, fulfillment_order_id: opts.fulfillmentOrderId ?? null, payload: opts.payload ?? null,
    })
  } catch { /* log best-effort */ }
}
