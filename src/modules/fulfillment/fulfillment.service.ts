import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { FulfillmentAiService } from './fulfillment-ai.service'
import { FulfillmentLabelsService, FULFILLMENT_BUCKET } from './fulfillment-labels.service'
import {
  DEFAULT_FULFILLMENT_SETTINGS,
  type ActionType, type FulfillmentSettings, type SeedItem, type SourceType,
  type DamageSeverity, type DamageResolution,
} from './fulfillment.types'

/**
 * F12 Fulfillment — core operacional do CD.
 *
 * Objetivo: eliminar erro de separação via bipagem obrigatória (SKU/EAN/QR) +
 * dupla checagem (pick → pack) + log auditável de TODA ação (operator_actions).
 *
 * Trabalha sobre a camada UNIFICADA `fulfillment_orders` (abstrai marketplace /
 * loja própria / b2b). Multi-tenant: tudo filtra organization_id.
 */
@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name)

  constructor(
    private readonly ai: FulfillmentAiService,
    private readonly labels: FulfillmentLabelsService,
  ) {}

  // ════════════════════════════════════════════════════════════════════
  // SETTINGS + WAREHOUSES
  // ════════════════════════════════════════════════════════════════════

  async getSettings(orgId: string): Promise<FulfillmentSettings> {
    const { data } = await supabaseAdmin
      .from('fulfillment_settings').select('*').eq('organization_id', orgId).maybeSingle()
    if (!data) return { organization_id: orgId, ...DEFAULT_FULFILLMENT_SETTINGS }
    return data as unknown as FulfillmentSettings
  }

  async updateSettings(orgId: string, patch: Partial<FulfillmentSettings>): Promise<FulfillmentSettings> {
    const row = {
      organization_id:              orgId,
      ai_damage_triage_enabled:     patch.ai_damage_triage_enabled,
      ai_pack_verification_enabled: patch.ai_pack_verification_enabled,
      ai_smart_queue_enabled:       patch.ai_smart_queue_enabled,
      photo_required_always:        patch.photo_required_always,
      photo_required_above_cents:   patch.photo_required_above_cents,
      photo_required_vip_channels:  patch.photo_required_vip_channels,
      updated_at:                   new Date().toISOString(),
    }
    Object.keys(row).forEach((k) => (row as Record<string, unknown>)[k] === undefined && delete (row as Record<string, unknown>)[k])
    const { error } = await supabaseAdmin
      .from('fulfillment_settings').upsert(row, { onConflict: 'organization_id' })
    if (error) throw new BadRequestException(`Erro ao salvar config: ${error.message}`)
    return this.getSettings(orgId)
  }

  async listWarehouses(orgId: string) {
    const { data } = await supabaseAdmin
      .from('warehouses').select('*').eq('organization_id', orgId)
      .order('created_at', { ascending: true })
    return data ?? []
  }

  async createWarehouse(orgId: string, input: { name: string; code: string; address?: Record<string, unknown> }) {
    if (!input?.name?.trim() || !input?.code?.trim()) throw new BadRequestException('Nome e código do CD são obrigatórios.')
    const { data, error } = await supabaseAdmin
      .from('warehouses')
      .insert({ organization_id: orgId, name: input.name.trim(), code: input.code.trim(), address: input.address ?? null })
      .select('*').maybeSingle()
    if (error) throw new BadRequestException(`Erro ao criar CD: ${error.message}`)
    return data
  }

  private async resolveWarehouse(orgId: string, warehouseId?: string): Promise<string> {
    if (warehouseId) {
      const { data } = await supabaseAdmin
        .from('warehouses').select('id').eq('id', warehouseId).eq('organization_id', orgId).maybeSingle()
      if (!data) throw new NotFoundException('CD (warehouse) não encontrado nesta org.')
      return warehouseId
    }
    const { data } = await supabaseAdmin
      .from('warehouses').select('id').eq('organization_id', orgId).eq('is_active', true)
      .order('created_at', { ascending: true }).limit(1).maybeSingle()
    if (!data) throw new BadRequestException('Nenhum CD cadastrado. Crie um centro de distribuição antes de separar.')
    return (data as { id: string }).id
  }

  // ════════════════════════════════════════════════════════════════════
  // SEED — ingere um pedido (qualquer origem) → fulfillment_order + tasks
  // ════════════════════════════════════════════════════════════════════

  async seed(orgId: string, input: {
    source: SourceType
    warehouseId?: string
    orderId?: string            // orders.id (marketplace) OU storefront_orders.id
    externalOrderId?: string    // external_order_id do ML
    customer?: Record<string, unknown>
    items?: SeedItem[]          // obrigatório p/ b2b
    channel?: string
  }): Promise<{ ok: true; fulfillmentOrderId: string; pickTasks: number; created: boolean }> {
    const warehouseId = await this.resolveWarehouse(orgId, input.warehouseId)
    const settings = await this.getSettings(orgId)

    let sourceId: string | null = null
    let channel = input.channel ?? null
    let reference: string | null = null
    let customer: Record<string, unknown> = input.customer ?? {}
    let items: SeedItem[] = []
    let sourceOrderIds: string[] = []
    let totalCents: number | null = null

    if (input.source === 'marketplace') {
      const externalId = input.externalOrderId
        ?? await this.lookupExternalId(orgId, input.orderId)
      if (!externalId) throw new BadRequestException('Informe externalOrderId ou orderId do pedido de marketplace.')
      const { data: rows } = await supabaseAdmin
        .from('orders')
        .select('id, sku, product_title, quantity, sale_price, buyer_name, platform')
        .eq('organization_id', orgId).eq('external_order_id', externalId)
      const orderRows = (rows ?? []) as Array<{ id: string; sku: string; product_title: string | null; quantity: number; sale_price: number | null; buyer_name: string | null; platform: string | null }>
      if (orderRows.length === 0) throw new NotFoundException('Pedido de marketplace não encontrado.')
      sourceId = externalId
      reference = externalId
      channel = channel ?? orderRows[0].platform ?? 'mercadolivre'
      customer = { name: orderRows[0].buyer_name ?? undefined }
      sourceOrderIds = orderRows.map((r) => r.id)
      totalCents = Math.round(orderRows.reduce((s, r) => s + (Number(r.sale_price) || 0), 0) * 100) || null
      items = orderRows.map((r) => ({ sku: r.sku, title: r.product_title ?? undefined, qty: r.quantity || 1 }))
    } else if (input.source === 'storefront') {
      if (!input.orderId) throw new BadRequestException('Informe orderId (storefront_orders.id).')
      const { data: so } = await supabaseAdmin
        .from('storefront_orders').select('*').eq('id', input.orderId).eq('organization_id', orgId).maybeSingle()
      if (!so) throw new NotFoundException('Pedido da loja própria não encontrado.')
      const order = so as { id: string; customer: Record<string, unknown>; items: Array<{ productId?: string; name?: string; price?: number; qty?: number }>; total: number | null }
      sourceId = order.id
      reference = order.id.slice(0, 8)
      channel = channel ?? 'loja'
      customer = order.customer ?? {}
      totalCents = order.total != null ? Math.round(Number(order.total) * 100) : null
      items = (order.items ?? []).map((i) => ({ sku: String(i.productId ?? i.name ?? 'item'), title: i.name, qty: Number(i.qty) || 1, productId: i.productId }))
    } else {
      // b2b — entrada manual
      if (!input.items?.length) throw new BadRequestException('Pedido B2B exige a lista de itens (items[]).')
      channel = channel ?? 'b2b'
      customer = input.customer ?? {}
      items = input.items
      reference = (customer as { name?: string }).name ?? 'B2B'
    }

    if (items.length === 0) throw new BadRequestException('Pedido sem itens para separar.')

    // Idempotência: mesmo (org, source_type, source_id) → devolve o existente
    if (sourceId) {
      const { data: existing } = await supabaseAdmin
        .from('fulfillment_orders').select('id')
        .eq('organization_id', orgId).eq('source_type', input.source).eq('source_id', sourceId)
        .maybeSingle()
      if (existing) {
        return { ok: true, fulfillmentOrderId: (existing as { id: string }).id, pickTasks: 0, created: false }
      }
    }

    const requiresPhoto =
      settings.photo_required_always
      || (totalCents != null && totalCents > settings.photo_required_above_cents)
      || (channel != null && settings.photo_required_vip_channels.includes(channel))

    // Cria o fulfillment_order
    const { data: foRow, error: foErr } = await supabaseAdmin
      .from('fulfillment_orders')
      .insert({
        organization_id: orgId,
        warehouse_id:    warehouseId,
        source_type:     input.source,
        source_id:       sourceId,
        source_order_ids: sourceOrderIds,
        channel,
        reference,
        customer,
        items_count:     items.length,
        total_cents:     totalCents,
        status:          'received',
      })
      .select('id').maybeSingle()
    if (foErr || !foRow) throw new BadRequestException(`Erro ao criar pedido de separação: ${foErr?.message ?? '?'}`)
    const foId = (foRow as { id: string }).id

    // Enriquece EAN do catálogo (por SKU) pra bipagem
    const eanBySku = await this.lookupEans(orgId, items.map((i) => i.sku))

    const pickRows = items.map((it) => ({
      organization_id:      orgId,
      warehouse_id:         warehouseId,
      fulfillment_order_id: foId,
      product_id:           it.productId ?? null,
      sku:                  it.sku,
      title:                it.title ?? null,
      expected_qty:         it.qty,
      expected_barcode:     it.barcode ?? eanBySku.get(it.sku) ?? null,
      status:               'pending',
    }))
    const { error: pErr } = await supabaseAdmin.from('pick_tasks').insert(pickRows)
    if (pErr) throw new BadRequestException(`Erro ao criar tarefas de separação: ${pErr.message}`)

    const { error: packErr } = await supabaseAdmin
      .from('pack_tasks')
      .insert({ organization_id: orgId, warehouse_id: warehouseId, fulfillment_order_id: foId, status: 'awaiting_pick', requires_photo: requiresPhoto })
    if (packErr) throw new BadRequestException(`Erro ao criar tarefa de conferência: ${packErr.message}`)

    return { ok: true, fulfillmentOrderId: foId, pickTasks: pickRows.length, created: true }
  }

  private async lookupExternalId(orgId: string, orderId?: string): Promise<string | null> {
    if (!orderId) return null
    const { data } = await supabaseAdmin
      .from('orders').select('external_order_id').eq('id', orderId).eq('organization_id', orgId).maybeSingle()
    return (data as { external_order_id: string | null } | null)?.external_order_id ?? null
  }

  private async lookupEans(orgId: string, skus: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    const unique = [...new Set(skus.filter(Boolean))]
    if (unique.length === 0) return map
    const { data } = await supabaseAdmin
      .from('products').select('sku, ean').eq('organization_id', orgId).in('sku', unique)
    for (const r of (data ?? []) as Array<{ sku: string; ean: string | null }>) {
      if (r.ean) map.set(r.sku, r.ean)
    }
    return map
  }

  // ════════════════════════════════════════════════════════════════════
  // PICKING
  // ════════════════════════════════════════════════════════════════════

  async pickQueue(orgId: string, warehouseId?: string) {
    let q = supabaseAdmin
      .from('pick_tasks')
      .select('id, fulfillment_order_id, sku, title, expected_qty, picked_qty, expected_barcode, status, priority, sla_deadline, warehouse_id')
      .eq('organization_id', orgId)
      .in('status', ['pending', 'in_progress'])
      .order('priority', { ascending: true })
      .order('sla_deadline', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .limit(200)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    const { data } = await q
    const tasks = (data ?? []) as Array<Record<string, unknown>>
    const foIds = [...new Set(tasks.map((t) => t.fulfillment_order_id as string))]
    const refs = await this.foRefs(orgId, foIds)
    return tasks.map((t) => ({ ...t, order: refs.get(t.fulfillment_order_id as string) ?? null }))
  }

  /** Bipagem do item: aceita SKU, EAN ou QR. Mismatch é bloqueado e logado. */
  async scanItem(orgId: string, userId: string, taskId: string, code: string): Promise<{ ok: boolean; matched: boolean; picked_qty: number; expected_qty: number; status: string }> {
    const task = await this.getPickTask(orgId, taskId)
    if (!['pending', 'in_progress'].includes(task.status)) {
      throw new BadRequestException(`Tarefa já está '${task.status}'.`)
    }
    const matched = matchCode(code, [task.sku, task.expected_barcode])
    if (!matched) {
      await this.log(orgId, userId, 'scan_mismatch', {
        warehouseId: task.warehouse_id, pickTaskId: taskId, fulfillmentOrderId: task.fulfillment_order_id,
        payload: { scanned: code, expected_sku: task.sku, expected_barcode: task.expected_barcode },
      })
      throw new BadRequestException(`Código não confere com este item (esperado SKU ${task.sku}${task.expected_barcode ? ' / EAN ' + task.expected_barcode : ''}).`)
    }

    const pickedQty = Math.min(task.expected_qty, (task.picked_qty ?? 0) + 1)
    const full = pickedQty >= task.expected_qty
    const update: Record<string, unknown> = {
      picked_qty: pickedQty,
      status:     full ? 'picked' : 'in_progress',
    }
    if (full) { update.picked_at = new Date().toISOString(); update.picked_by = userId }
    await supabaseAdmin.from('pick_tasks').update(update).eq('id', taskId).eq('organization_id', orgId)
    await this.markOrderPicking(orgId, task.fulfillment_order_id)
    await this.log(orgId, userId, full ? 'pick_complete' : 'scan_item', {
      warehouseId: task.warehouse_id, pickTaskId: taskId, fulfillmentOrderId: task.fulfillment_order_id,
      payload: { scanned: code, picked_qty: pickedQty },
    })
    return { ok: true, matched: true, picked_qty: pickedQty, expected_qty: task.expected_qty, status: full ? 'picked' : 'in_progress' }
  }

  async pickComplete(orgId: string, userId: string, taskId: string) {
    const task = await this.getPickTask(orgId, taskId)
    await supabaseAdmin.from('pick_tasks')
      .update({ status: 'picked', picked_qty: task.expected_qty, picked_at: new Date().toISOString(), picked_by: userId })
      .eq('id', taskId).eq('organization_id', orgId)
    await this.log(orgId, userId, 'pick_complete', { warehouseId: task.warehouse_id, pickTaskId: taskId, fulfillmentOrderId: task.fulfillment_order_id })
    return { ok: true }
  }

  async pickBlock(orgId: string, userId: string, taskId: string, reason: string) {
    const task = await this.getPickTask(orgId, taskId)
    await supabaseAdmin.from('pick_tasks').update({ status: 'blocked', block_reason: reason || 'sem motivo' }).eq('id', taskId).eq('organization_id', orgId)
    await supabaseAdmin.from('fulfillment_orders').update({ status: 'blocked', block_reason: reason || 'sem motivo' }).eq('id', task.fulfillment_order_id).eq('organization_id', orgId)
    await this.log(orgId, userId, 'block_pick', { warehouseId: task.warehouse_id, pickTaskId: taskId, fulfillmentOrderId: task.fulfillment_order_id, payload: { reason } })
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════
  // PACKING
  // ════════════════════════════════════════════════════════════════════

  async packQueue(orgId: string, warehouseId?: string) {
    let q = supabaseAdmin
      .from('pack_tasks')
      .select('id, fulfillment_order_id, status, requires_photo, photo_url, scanned_order_at, warehouse_id')
      .eq('organization_id', orgId)
      .in('status', ['ready_to_pack', 'in_progress'])
      .order('created_at', { ascending: true })
      .limit(200)
    if (warehouseId) q = q.eq('warehouse_id', warehouseId)
    const { data } = await q
    const tasks = (data ?? []) as Array<Record<string, unknown>>
    const foIds = [...new Set(tasks.map((t) => t.fulfillment_order_id as string))]
    const refs = await this.foRefs(orgId, foIds)
    const itemsByFo = await this.itemsByFo(orgId, foIds)
    return tasks.map((t) => ({
      ...t,
      order: refs.get(t.fulfillment_order_id as string) ?? null,
      items: itemsByFo.get(t.fulfillment_order_id as string) ?? [],
    }))
  }

  /** Bipagem do pedido (libera a conferência). Aceita referência / id / QR. */
  async packScanOrder(orgId: string, userId: string, packId: string, code: string) {
    const pack = await this.getPackTask(orgId, packId)
    if (pack.status === 'awaiting_pick') throw new BadRequestException('Separação ainda não concluída (aguarde os itens).')
    const fo = await this.getFo(orgId, pack.fulfillment_order_id)
    const matched = matchCode(code, [fo.reference, fo.source_id, fo.id, packId])
    if (!matched) {
      await this.log(orgId, userId, 'scan_mismatch', { warehouseId: pack.warehouse_id, packTaskId: packId, fulfillmentOrderId: fo.id, payload: { scanned: code, expected_ref: fo.reference } })
      throw new BadRequestException('Código do pedido não confere com esta conferência.')
    }
    await supabaseAdmin.from('pack_tasks').update({ status: 'in_progress', scanned_order_at: new Date().toISOString(), scanned_by: userId }).eq('id', packId).eq('organization_id', orgId)
    await this.log(orgId, userId, 'scan_order', { warehouseId: pack.warehouse_id, packTaskId: packId, fulfillmentOrderId: fo.id })
    return { ok: true }
  }

  /** Foto do pacote (upload bucket privado). Opcional: roda IA de conferência. */
  async packPhoto(orgId: string, userId: string, packId: string, imageBase64: string, mimeType?: string) {
    const pack = await this.getPackTask(orgId, packId)
    const { buffer, mime, ext } = decodeImage(imageBase64, mimeType)
    const path = `${orgId}/pack/${packId}/${Date.now()}.${ext}`
    const { error } = await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).upload(path, buffer, { contentType: mime, upsert: false })
    if (error) throw new BadRequestException(`Falha ao salvar foto: ${error.message}`)

    const update: Record<string, unknown> = { photo_url: path }

    const settings = await this.getSettings(orgId)
    if (settings.ai_pack_verification_enabled) {
      const signed = await this.labels.signedUrl(path, 600)
      if (signed) {
        const items = await this.itemsByFoOne(orgId, pack.fulfillment_order_id)
        const verdict = await this.ai.verifyPackPhoto({ orgId, imageUrl: signed, expectedItems: items })
        if (verdict) { update.ai_verification_passed = verdict.passed ?? null; update.ai_verification_result = verdict.result ?? null }
      }
    }

    await supabaseAdmin.from('pack_tasks').update(update).eq('id', packId).eq('organization_id', orgId)
    await this.log(orgId, userId, 'photo_taken', { warehouseId: pack.warehouse_id, packTaskId: packId, fulfillmentOrderId: pack.fulfillment_order_id, payload: { path } })
    const signedUrl = await this.labels.signedUrl(path, 600)
    return { ok: true, photoUrl: signedUrl, aiVerification: update.ai_verification_passed ?? null }
  }

  /** Fecha a conferência. Exige bipagem do pedido + foto (se requires_photo). */
  async packComplete(orgId: string, userId: string, packId: string) {
    const pack = await this.getPackTask(orgId, packId)
    if (!pack.scanned_order_at) throw new BadRequestException('Bipe o pedido antes de fechar a conferência.')
    if (pack.requires_photo && !pack.photo_url) throw new BadRequestException('Este pedido exige foto antes de fechar.')
    await supabaseAdmin.from('pack_tasks').update({ status: 'packed', packed_at: new Date().toISOString(), packed_by: userId }).eq('id', packId).eq('organization_id', orgId)
    await supabaseAdmin.from('fulfillment_orders').update({ status: 'packed' }).eq('id', pack.fulfillment_order_id).eq('organization_id', orgId)
    await this.log(orgId, userId, 'pack_complete', { warehouseId: pack.warehouse_id, packTaskId: packId, fulfillmentOrderId: pack.fulfillment_order_id })
    return { ok: true }
  }

  // ════════════════════════════════════════════════════════════════════
  // DAMAGE + LABELS + DASHBOARD
  // ════════════════════════════════════════════════════════════════════

  async reportDamage(orgId: string, userId: string, input: {
    warehouseId?: string; pickTaskId?: string; fulfillmentOrderId?: string
    sku: string; severity: DamageSeverity; description?: string
    photosBase64?: string[]; resolution?: DamageResolution
  }) {
    if (!input.sku) throw new BadRequestException('SKU obrigatório.')
    const warehouseId = await this.resolveWarehouse(orgId, input.warehouseId)

    const photoPaths: string[] = []
    for (const b64 of (input.photosBase64 ?? []).slice(0, 5)) {
      try {
        const { buffer, mime, ext } = decodeImage(b64)
        const path = `${orgId}/damage/${Date.now()}-${photoPaths.length}.${ext}`
        const { error } = await supabaseAdmin.storage.from(FULFILLMENT_BUCKET).upload(path, buffer, { contentType: mime, upsert: false })
        if (!error) photoPaths.push(path)
      } catch { /* ignora foto inválida */ }
    }

    // IA de triagem (best-effort, só se ligada)
    let aiSeverity: string | null = null, aiResolution: string | null = null, aiConfidence: number | null = null, aiAnalysis: Record<string, unknown> | null = null
    const settings = await this.getSettings(orgId)
    if (settings.ai_damage_triage_enabled && photoPaths.length > 0) {
      const signed = await this.labels.signedUrl(photoPaths[0], 600)
      if (signed) {
        const triage = await this.ai.triageDamage({ orgId, sku: input.sku, imageUrl: signed, description: input.description })
        if (triage) { aiSeverity = triage.severity ?? null; aiResolution = triage.resolution ?? null; aiConfidence = triage.confidence ?? null; aiAnalysis = triage.analysis ?? null }
      }
    }

    const { data, error } = await supabaseAdmin.from('damage_reports').insert({
      organization_id: orgId, warehouse_id: warehouseId, reported_by: userId,
      pick_task_id: input.pickTaskId ?? null, fulfillment_order_id: input.fulfillmentOrderId ?? null,
      sku: input.sku, severity: input.severity, description: input.description ?? null,
      photo_urls: photoPaths, resolution: input.resolution ?? 'pending',
      ai_suggested_severity: aiSeverity, ai_suggested_resolution: aiResolution, ai_confidence: aiConfidence, ai_analysis: aiAnalysis,
    }).select('id').maybeSingle()
    if (error) throw new BadRequestException(`Erro ao registrar avaria: ${error.message}`)

    await this.log(orgId, userId, 'damage_reported', { warehouseId, pickTaskId: input.pickTaskId, fulfillmentOrderId: input.fulfillmentOrderId, payload: { sku: input.sku, severity: input.severity } })
    return { ok: true, id: (data as { id: string } | null)?.id, aiSuggested: aiSeverity ? { severity: aiSeverity, resolution: aiResolution, confidence: aiConfidence } : null }
  }

  async printLabel(orgId: string, userId: string, fulfillmentOrderId: string) {
    const fo = await this.getFo(orgId, fulfillmentOrderId)
    const items = await this.itemsByFoOne(orgId, fulfillmentOrderId)
    const result = await this.labels.generate(orgId, fo, items)

    const { data, error } = await supabaseAdmin.from('shipment_labels').insert({
      organization_id: orgId, fulfillment_order_id: fulfillmentOrderId,
      marketplace: result.marketplace, tracking_code: result.trackingCode,
      label_format: result.format, label_url: result.storagePath, printed_at: new Date().toISOString(), printed_by: userId,
    }).select('id').maybeSingle()
    if (error) throw new BadRequestException(`Erro ao salvar etiqueta: ${error.message}`)

    // marca pedido como shipped + pack shipped
    await supabaseAdmin.from('fulfillment_orders').update({ status: 'shipped' }).eq('id', fulfillmentOrderId).eq('organization_id', orgId)
    await supabaseAdmin.from('pack_tasks').update({ status: 'shipped', shipped_at: new Date().toISOString() }).eq('fulfillment_order_id', fulfillmentOrderId).eq('organization_id', orgId)
    await this.log(orgId, userId, 'label_printed', { fulfillmentOrderId, payload: { format: result.format, tracking: result.trackingCode } })

    const signedUrl = await this.labels.signedUrl(result.storagePath, 600)
    return { ok: true, id: (data as { id: string } | null)?.id, format: result.format, trackingCode: result.trackingCode, labelUrl: signedUrl }
  }

  async dashboard(orgId: string, warehouseId?: string) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)

    const pickCountQ = supabaseAdmin.from('pick_tasks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).in('status', ['pending', 'in_progress'])
    const packCountQ = supabaseAdmin.from('pack_tasks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).in('status', ['ready_to_pack', 'in_progress'])
    if (warehouseId) { pickCountQ.eq('warehouse_id', warehouseId); packCountQ.eq('warehouse_id', warehouseId) }
    const [{ count: pickQueue }, { count: packQueue }] = await Promise.all([pickCountQ, packCountQ])

    const { data: actions } = await supabaseAdmin
      .from('operator_actions').select('id, action_type, user_id, fulfillment_order_id, payload, created_at')
      .eq('organization_id', orgId).gte('created_at', since)
      .order('created_at', { ascending: false }).limit(50)

    const { count: damagesToday } = await supabaseAdmin
      .from('damage_reports').select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).gte('created_at', todayStart.toISOString())

    const { count: mismatch24h } = await supabaseAdmin
      .from('operator_actions').select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId).eq('action_type', 'scan_mismatch').gte('created_at', since)

    return {
      pickQueue: pickQueue ?? 0,
      packQueue: packQueue ?? 0,
      damagesToday: damagesToday ?? 0,
      mismatch24h: mismatch24h ?? 0,
      recentActions: actions ?? [],
    }
  }

  // ════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════

  private async log(orgId: string, userId: string, actionType: ActionType, opts: {
    warehouseId?: string | null; pickTaskId?: string; packTaskId?: string; fulfillmentOrderId?: string; payload?: Record<string, unknown>
  }) {
    try {
      await supabaseAdmin.from('operator_actions').insert({
        organization_id: orgId, user_id: userId, warehouse_id: opts.warehouseId ?? null,
        action_type: actionType, pick_task_id: opts.pickTaskId ?? null, pack_task_id: opts.packTaskId ?? null,
        fulfillment_order_id: opts.fulfillmentOrderId ?? null, payload: opts.payload ?? null,
      })
    } catch (e) {
      this.logger.warn(`[log] falha ao gravar operator_action ${actionType}: ${(e as Error).message}`)
    }
  }

  private async markOrderPicking(orgId: string, foId: string) {
    await supabaseAdmin.from('fulfillment_orders').update({ status: 'picking' }).eq('id', foId).eq('organization_id', orgId).eq('status', 'received')
  }

  private async getPickTask(orgId: string, taskId: string) {
    const { data } = await supabaseAdmin.from('pick_tasks').select('*').eq('id', taskId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Tarefa de separação não encontrada.')
    return data as unknown as { id: string; sku: string; expected_barcode: string | null; expected_qty: number; picked_qty: number; status: string; warehouse_id: string; fulfillment_order_id: string }
  }

  private async getPackTask(orgId: string, packId: string) {
    const { data } = await supabaseAdmin.from('pack_tasks').select('*').eq('id', packId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Tarefa de conferência não encontrada.')
    return data as unknown as { id: string; status: string; requires_photo: boolean; photo_url: string | null; scanned_order_at: string | null; warehouse_id: string; fulfillment_order_id: string }
  }

  private async getFo(orgId: string, foId: string) {
    const { data } = await supabaseAdmin.from('fulfillment_orders').select('*').eq('id', foId).eq('organization_id', orgId).maybeSingle()
    if (!data) throw new NotFoundException('Pedido de separação não encontrado.')
    return data as unknown as { id: string; organization_id: string; source_type: string; source_id: string | null; source_order_ids: string[]; channel: string | null; reference: string | null; customer: Record<string, unknown> }
  }

  private async foRefs(orgId: string, foIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    const map = new Map<string, Record<string, unknown>>()
    if (foIds.length === 0) return map
    const { data } = await supabaseAdmin
      .from('fulfillment_orders').select('id, reference, channel, source_type, customer, items_count, status')
      .eq('organization_id', orgId).in('id', foIds)
    for (const r of (data ?? []) as Array<Record<string, unknown>>) map.set(r.id as string, r)
    return map
  }

  private async itemsByFo(orgId: string, foIds: string[]): Promise<Map<string, Array<{ sku: string; title: string | null; qty: number }>>> {
    const map = new Map<string, Array<{ sku: string; title: string | null; qty: number }>>()
    if (foIds.length === 0) return map
    const { data } = await supabaseAdmin
      .from('pick_tasks').select('fulfillment_order_id, sku, title, expected_qty')
      .eq('organization_id', orgId).in('fulfillment_order_id', foIds)
    for (const r of (data ?? []) as Array<{ fulfillment_order_id: string; sku: string; title: string | null; expected_qty: number }>) {
      const arr = map.get(r.fulfillment_order_id) ?? []
      arr.push({ sku: r.sku, title: r.title, qty: r.expected_qty })
      map.set(r.fulfillment_order_id, arr)
    }
    return map
  }

  private async itemsByFoOne(orgId: string, foId: string): Promise<Array<{ sku: string; title: string | null; qty: number }>> {
    return (await this.itemsByFo(orgId, [foId])).get(foId) ?? []
  }
}

// ── code matching (SKU / EAN / QR) ──────────────────────────────────────
function normalizeCode(s: string): string {
  return String(s ?? '').trim().toUpperCase().replace(/\s+/g, '')
}

/** Extrai candidatos de um scan: aceita texto cru, prefixos (SKU:/EAN:),
 *  JSON ({"sku":..,"ean":..}), e URL (último segmento). */
function scanCandidates(raw: string): string[] {
  const out = new Set<string>()
  const s = String(raw ?? '').trim()
  if (!s) return []
  out.add(normalizeCode(s))
  // prefixo TIPO:VALOR
  const m = s.match(/^(sku|ean|gtin|cod|order|pick)\s*[:=]\s*(.+)$/i)
  if (m) out.add(normalizeCode(m[2]))
  // JSON
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s) as Record<string, unknown>
      for (const k of ['sku', 'ean', 'gtin', 'barcode', 'id', 'reference', 'ref']) {
        if (typeof j[k] === 'string') out.add(normalizeCode(j[k] as string))
      }
    } catch { /* não é JSON */ }
  }
  // URL → último segmento
  if (/^https?:\/\//i.test(s)) {
    const seg = s.split(/[?#]/)[0].split('/').filter(Boolean).pop()
    if (seg) out.add(normalizeCode(seg))
  }
  return [...out]
}

function matchCode(scanned: string, targets: Array<string | null | undefined>): boolean {
  const cands = scanCandidates(scanned)
  if (cands.length === 0) return false
  const norm = targets.filter((t): t is string => !!t).map(normalizeCode)
  return cands.some((c) => norm.includes(c))
}

// ── image decode (base64 data-url ou cru) ───────────────────────────────
function decodeImage(input: string, mimeHint?: string): { buffer: Buffer; mime: string; ext: string } {
  let b64 = input ?? ''
  let mime = mimeHint ?? 'image/jpeg'
  const dataUrl = b64.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i)
  if (dataUrl) { mime = dataUrl[1]; b64 = dataUrl[2] }
  let buffer: Buffer
  try { buffer = Buffer.from(b64, 'base64') } catch { throw new BadRequestException('Imagem inválida.') }
  if (buffer.length < 512) throw new BadRequestException('Imagem muito pequena ou corrompida.')
  if (buffer.length > 8 * 1024 * 1024) throw new BadRequestException('Imagem muito grande (máx. 8MB).')
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg'
  return { buffer, mime, ext }
}
