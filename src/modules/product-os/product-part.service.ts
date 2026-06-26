import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { ProductionInputService } from './production-input.service'

/**
 * Product OS — PEÇAS & MONTAGEM.
 *
 * Um produto pode ser composto por várias PEÇAS imprimíveis (base, cúpula,
 * conector…). Cada peça tem versões/arquivos próprios, pode ser produzida
 * sozinha (OP de peça → credita o estoque de peças prontas) e a MONTAGEM
 * consome peças prontas + insumos de montagem → vira produto acabado.
 *
 * Espelha o ledger de insumos (master + movimentos, reserva/consumo idempotente).
 */

const CHANNEL_ALLIN_FEE_PCT: Record<string, number> = {
  mercado_livre: 24.5, shopee: 31.6, tiktok: 8, loja: 0,
}

const ASSEMBLY_TRANSITIONS: Record<string, string[]> = {
  fila:      ['montando', 'cancelado'],
  montando:  ['concluido', 'cancelado'],
  concluido: [],
  cancelado: [],
}

interface PartRef { id: string; name: string; qty_per_product: number; stock_qty: number; reserved_qty: number }
interface PartVersionMetrics { weight_g: number | null; print_time_minutes: number | null; material: string | null }

@Injectable()
export class ProductPartService {
  private readonly logger = new Logger(ProductPartService.name)

  constructor(private readonly inputs: ProductionInputService) {}

  private round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

  private async emit(orgId: string, devId: string, type: string, payload: Record<string, unknown>, userId?: string | null) {
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: devId, event_type: type, payload, actor_id: userId ?? null,
    }).then(() => {}, () => {})
  }

  // ══ Peças (CRUD) ═══════════════════════════════════════════════════
  async listParts(orgId: string, devId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_part').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('sort_order', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []).map(p => {
      const r = p as PartRef & { is_optional: boolean }
      return { ...r, available: this.round2(Number(r.stock_qty) - Number(r.reserved_qty)) }
    })
  }

  async createPart(orgId: string, devId: string, userId: string | null, dto: { name: string; qty_per_product?: number; is_optional?: boolean; sort_order?: number; notes?: string }) {
    if (!dto.name?.trim()) throw new BadRequestException('Nome da peça é obrigatório')
    const { data: dev } = await supabaseAdmin.from('product_dev').select('id').eq('id', devId).eq('organization_id', orgId).maybeSingle()
    if (!dev) throw new NotFoundException('Produto não encontrado')
    const { data: seq } = await supabaseAdmin.from('product_dev_part').select('sort_order')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('sort_order', { ascending: false }).limit(1).maybeSingle()
    const nextSort = dto.sort_order ?? (seq ? Number((seq as { sort_order: number }).sort_order) + 1 : 0)
    const { data, error } = await supabaseAdmin.from('product_dev_part').insert({
      organization_id: orgId, product_dev_id: devId, name: dto.name.trim(),
      qty_per_product: Math.max(1, Number(dto.qty_per_product) || 1), is_optional: dto.is_optional === true,
      sort_order: nextSort, notes: dto.notes ?? null, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar peça: ${error?.message ?? 'sem dados'}`)
    await this.emit(orgId, devId, 'part_added' as string, { part_id: (data as { id: string }).id, name: dto.name }, userId)
    return data
  }

  async updatePart(orgId: string, partId: string, patch: { name?: string; qty_per_product?: number; is_optional?: boolean; sort_order?: number; notes?: string }) {
    const safe: Record<string, unknown> = {}
    if (patch.name != null) safe.name = String(patch.name).trim()
    if (patch.qty_per_product != null) safe.qty_per_product = Math.max(1, Number(patch.qty_per_product) || 1)
    if (patch.is_optional != null) safe.is_optional = patch.is_optional === true
    if (patch.sort_order != null) safe.sort_order = Number(patch.sort_order) || 0
    if (patch.notes != null) safe.notes = patch.notes
    if (!Object.keys(safe).length) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin.from('product_dev_part').update(safe)
      .eq('id', partId).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrada'}`)
    return data
  }

  /** Exclui a peça (+ versões + movimentos, via cascade do banco). Bloqueia se
   *  houver reserva ativa (montagem/OP em andamento) — nesse caso conclua/cancele antes. */
  async deletePart(orgId: string, partId: string): Promise<{ deleted: boolean }> {
    const part = await this.getPart(orgId, partId)
    if (Number(part.reserved_qty) > 0) throw new BadRequestException('Peça reservada por uma montagem/ordem em andamento — conclua ou cancele antes de excluir.')
    const { data: po } = await supabaseAdmin.from('production_order').select('id')
      .eq('organization_id', orgId).eq('part_id', partId).not('status', 'in', '(disponivel,cancelado)').limit(1).maybeSingle()
    if (po) throw new BadRequestException('Existe uma ordem de produção em andamento para esta peça — conclua ou cancele antes de excluir.')
    const { error } = await supabaseAdmin.from('product_dev_part').delete().eq('id', partId).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao excluir: ${error.message}`)
    return { deleted: true }
  }

  private async getPart(orgId: string, partId: string): Promise<PartRef & { product_dev_id: string }> {
    const { data, error } = await supabaseAdmin.from('product_dev_part').select('*')
      .eq('id', partId).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Peça não encontrada')
    return data as PartRef & { product_dev_id: string }
  }

  // ══ Versões da peça (reusa product_dev_version com part_id) ═════════
  async listPartVersions(orgId: string, partId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_version').select('*')
      .eq('organization_id', orgId).eq('part_id', partId).order('version_number', { ascending: false })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async addPartVersion(orgId: string, partId: string, userId: string | null, body: {
    changelog?: string; file_url?: string; file_type?: string; material?: string
    weight_g?: number; print_time_minutes?: number; volume_cm3?: number; prototype_photo_urls?: string[]; notes?: string
  }) {
    const part = await this.getPart(orgId, partId)
    const existing = await this.listPartVersions(orgId, partId) as Array<{ version_number: number }>
    const nextNumber = existing.length ? Number(existing[0].version_number) + 1 : 1
    const { data, error } = await supabaseAdmin.from('product_dev_version').insert({
      organization_id: orgId, product_dev_id: part.product_dev_id, part_id: partId, version_number: nextNumber,
      changelog: body.changelog ?? null, file_url: body.file_url ?? null, file_type: body.file_type ?? null,
      material: body.material ?? null, weight_g: body.weight_g ?? null, print_time_minutes: body.print_time_minutes ?? null,
      volume_cm3: body.volume_cm3 ?? null, prototype_photo_urls: body.prototype_photo_urls ?? [], status: 'rascunho',
      notes: body.notes ?? null, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar versão da peça: ${error?.message ?? 'sem dados'}`)
    return data
  }

  /** Métricas de fabricação da peça: versão aprovada > última. */
  private async resolvePartMetrics(orgId: string, partId: string): Promise<PartVersionMetrics> {
    const versions = await this.listPartVersions(orgId, partId) as Array<{ approved: boolean; weight_g: number | null; print_time_minutes: number | null; material: string | null }>
    const ref = versions.find(v => v.approved) ?? versions[0]
    return { weight_g: ref?.weight_g ?? null, print_time_minutes: ref?.print_time_minutes ?? null, material: ref?.material ?? null }
  }

  // ══ Estoque de peças prontas (ledger) ══════════════════════════════
  async listPartMovements(orgId: string, partId: string) {
    const { data, error } = await supabaseAdmin.from('product_dev_part_movement').select('*')
      .eq('organization_id', orgId).eq('part_id', partId).order('created_at', { ascending: false }).limit(100)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** Crédito de peças prontas ao concluir a OP da peça. Idempotente por OP. */
  async creditFromOrder(orgId: string, partId: string, qty: number, orderId: string, userId: string | null): Promise<void> {
    const q = Math.max(0, Number(qty) || 0)
    if (q <= 0) return
    const { data: done } = await supabaseAdmin.from('product_dev_part_movement').select('id')
      .eq('part_id', partId).eq('reference_type', 'production_order').eq('reference_id', orderId).eq('movement_type', 'produced').maybeSingle()
    if (done) return
    const part = await this.getPart(orgId, partId)
    const novo = this.round2(Number(part.stock_qty) + q)
    await supabaseAdmin.from('product_dev_part').update({ stock_qty: novo, updated_at: new Date().toISOString() }).eq('id', partId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'produced', quantity: q, balance_after: novo,
      reference_type: 'production_order', reference_id: orderId, notes: 'Peças prontas (conclusão da OP)', created_by: userId,
    })
    this.logger.log(`[peca] +${q} prontas em ${partId.slice(0, 8)} (estoque=${novo})`)
  }

  /** Ajuste manual do estoque de peças (define o valor absoluto). */
  async adjustStock(orgId: string, partId: string, newQty: number, userId: string | null) {
    const part = await this.getPart(orgId, partId)
    const novo = Math.max(0, Number(newQty) || 0)
    await supabaseAdmin.from('product_dev_part').update({ stock_qty: novo, updated_at: new Date().toISOString() }).eq('id', partId).eq('organization_id', orgId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'adjust', quantity: novo, balance_after: novo,
      reference_type: 'manual', reference_id: null, notes: 'Ajuste manual de estoque', created_by: userId,
    })
    return { ...part, stock_qty: novo }
  }

  private async reservePart(orgId: string, partId: string, qty: number, refType: string, refId: string): Promise<boolean> {
    const q = Math.max(0, Number(qty) || 0)
    if (q <= 0) return false
    const { data: existing } = await supabaseAdmin.from('product_dev_part_movement').select('id')
      .eq('part_id', partId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve').maybeSingle()
    if (existing) return true
    const part = await this.getPart(orgId, partId)
    await supabaseAdmin.from('product_dev_part').update({ reserved_qty: this.round2(Number(part.reserved_qty) + q), updated_at: new Date().toISOString() }).eq('id', partId)
    await supabaseAdmin.from('product_dev_part_movement').insert({
      organization_id: orgId, part_id: partId, movement_type: 'reserve', quantity: q,
      reference_type: refType, reference_id: refId, notes: 'Reserva p/ montagem',
    })
    return true
  }

  private async releaseParts(orgId: string, refType: string, refId: string): Promise<void> {
    const { data: reserves } = await supabaseAdmin.from('product_dev_part_movement').select('part_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve')
    for (const rm of (reserves ?? []) as Array<{ part_id: string; quantity: number }>) {
      const { data: released } = await supabaseAdmin.from('product_dev_part_movement').select('id')
        .eq('part_id', rm.part_id).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'release').maybeSingle()
      if (released) continue
      const { data: part } = await supabaseAdmin.from('product_dev_part').select('reserved_qty').eq('id', rm.part_id).maybeSingle()
      if (!part) continue
      const novaRes = Math.max(0, this.round2(Number((part as { reserved_qty: number }).reserved_qty) - Number(rm.quantity)))
      await supabaseAdmin.from('product_dev_part').update({ reserved_qty: novaRes, updated_at: new Date().toISOString() }).eq('id', rm.part_id)
      await supabaseAdmin.from('product_dev_part_movement').insert({
        organization_id: orgId, part_id: rm.part_id, movement_type: 'release', quantity: Number(rm.quantity),
        reference_type: refType, reference_id: refId, notes: 'Liberação de reserva (cancelamento)',
      })
    }
  }

  private async consumeParts(orgId: string, refType: string, refId: string): Promise<void> {
    const { data: reserves } = await supabaseAdmin.from('product_dev_part_movement').select('part_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve')
    for (const rm of (reserves ?? []) as Array<{ part_id: string; quantity: number }>) {
      const { data: consumed } = await supabaseAdmin.from('product_dev_part_movement').select('id')
        .eq('part_id', rm.part_id).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'consume').maybeSingle()
      if (consumed) continue
      const { data: part } = await supabaseAdmin.from('product_dev_part').select('stock_qty, reserved_qty').eq('id', rm.part_id).maybeSingle()
      if (!part) continue
      const reserved = Number(rm.quantity)
      const novaQtd = Math.max(0, this.round2(Number((part as { stock_qty: number }).stock_qty) - reserved))
      const novaRes = Math.max(0, this.round2(Number((part as { reserved_qty: number }).reserved_qty) - reserved))
      await supabaseAdmin.from('product_dev_part').update({ stock_qty: novaQtd, reserved_qty: novaRes, updated_at: new Date().toISOString() }).eq('id', rm.part_id)
      await supabaseAdmin.from('product_dev_part_movement').insert({
        organization_id: orgId, part_id: rm.part_id, movement_type: 'consume', quantity: reserved, balance_after: novaQtd,
        reference_type: refType, reference_id: refId, notes: 'Consumo na montagem',
      })
    }
  }

  // ══ Montagem (assembly) ════════════════════════════════════════════
  /** Prévia: o que montar X produtos consome de peças + insumos, com faltas. */
  async previewAssembly(orgId: string, devId: string, quantity: number) {
    const qty = Math.max(1, Math.floor(Number(quantity) || 0))
    const parts = await this.listParts(orgId, devId) as Array<PartRef & { available: number; is_optional: boolean }>
    if (!parts.length) throw new BadRequestException('Este produto não tem peças cadastradas. Cadastre as peças primeiro.')
    const partLines = parts.map(p => {
      const needed = this.round2(Number(p.qty_per_product) * qty)
      return { type: 'peca', part_id: p.id, name: p.name, needed, available: p.available, unit: 'un', is_optional: p.is_optional, sufficient: p.available >= needed, missing: Math.max(0, this.round2(needed - p.available)) }
    })
    // insumos de montagem: linhas de BOM do produto que NÃO são filamento (embalagem/etiqueta/mão de obra)
    const { data: bom } = await supabaseAdmin.from('product_dev_bom').select('input_id, kind, description, quantity, waste_pct')
      .eq('organization_id', orgId).eq('product_dev_id', devId).is('version_id', null)
    const insumoNeed = new Map<string, number>()
    for (const l of (bom ?? []) as Array<{ input_id: string | null; kind: string; quantity: number; waste_pct: number }>) {
      if (!l.input_id || l.kind === 'filamento' || Number(l.quantity) <= 0) continue
      const need = Number(l.quantity) * qty * (1 + Number(l.waste_pct) / 100)
      insumoNeed.set(l.input_id, (insumoNeed.get(l.input_id) ?? 0) + need)
    }
    const insumoLines: Array<{ type: string; input_id: string; name: string; needed: number; available: number; unit: string; sufficient: boolean; missing: number }> = []
    if (insumoNeed.size) {
      const { data: inputs } = await supabaseAdmin.from('production_input').select('id, name, unit, quantity, reserved_quantity').in('id', [...insumoNeed.keys()])
      const map = new Map((inputs ?? []).map(i => [(i as { id: string }).id, i as { id: string; name: string; unit: string; quantity: number; reserved_quantity: number }]))
      for (const [id, need] of insumoNeed) {
        const i = map.get(id)
        const available = i ? this.round2(Number(i.quantity) - Number(i.reserved_quantity)) : 0
        insumoLines.push({ type: 'insumo', input_id: id, name: i?.name ?? '(insumo removido)', needed: this.round2(need), available, unit: i?.unit ?? 'un', sufficient: !!i && available >= need, missing: Math.max(0, this.round2(need - available)) })
      }
    }
    const required = partLines.filter(l => !l.is_optional)
    return {
      quantity: qty, parts: partLines, insumos: insumoLines,
      all_sufficient: required.every(l => l.sufficient) && insumoLines.every(l => l.sufficient),
      missing_parts: partLines.filter(l => !l.is_optional && !l.sufficient).map(l => ({ part_id: l.part_id, name: l.name, missing: l.missing })),
    }
  }

  async listAssemblies(orgId: string, opts: { product_dev_id?: string; status?: string } = {}) {
    let q = supabaseAdmin.from('assembly_order').select('*').eq('organization_id', orgId).order('created_at', { ascending: false })
    if (opts.product_dev_id) q = q.eq('product_dev_id', opts.product_dev_id)
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async getAssembly(orgId: string, aid: string) {
    const { data, error } = await supabaseAdmin.from('assembly_order').select('*').eq('id', aid).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Montagem não encontrada')
    return data
  }

  /** Cria a montagem: exige peças/insumos suficientes (senão erro com a falta) e reserva tudo. */
  async createAssembly(orgId: string, devId: string, userId: string | null, quantity: number) {
    const qty = Math.max(1, Math.floor(Number(quantity) || 0))
    const preview = await this.previewAssembly(orgId, devId, qty)
    if (!preview.all_sufficient) {
      const faltas = [
        ...preview.parts.filter(l => !l.is_optional && !l.sufficient).map(l => `${l.name} (faltam ${l.missing})`),
        ...preview.insumos.filter(l => !l.sufficient).map(l => `${l.name} (faltam ${l.missing} ${l.unit})`),
      ].join(', ')
      throw new BadRequestException(`Estoque insuficiente p/ montar ${qty}: ${faltas}. Gere as OPs de impressão das peças que faltam ou reponha os insumos.`)
    }
    const { data: seq } = await supabaseAdmin.from('assembly_order').select('order_number')
      .eq('organization_id', orgId).order('order_number', { ascending: false }).limit(1).maybeSingle()
    const nextNumber = seq ? Number((seq as { order_number: number }).order_number) + 1 : 1
    const { data, error } = await supabaseAdmin.from('assembly_order').insert({
      organization_id: orgId, product_dev_id: devId, order_number: nextNumber, quantity: qty, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar montagem: ${error?.message ?? 'sem dados'}`)
    const asm = data as { id: string }
    // reserva peças + insumos de montagem
    for (const l of preview.parts) await this.reservePart(orgId, l.part_id, l.needed, 'assembly_order', asm.id)
    for (const l of preview.insumos) await this.inputs.reserveInput(orgId, l.input_id, l.needed, 'assembly_order', asm.id)
    await this.emit(orgId, devId, 'assembly_created' as string, { assembly_order_id: asm.id, qty }, userId)
    return this.getAssembly(orgId, asm.id)
  }

  async transitionAssembly(orgId: string, aid: string, to: string, userId: string | null) {
    const asm = await this.getAssembly(orgId, aid) as { id: string; status: string; product_dev_id: string; quantity: number; stock_movement_done: boolean }
    const from = asm.status
    if (from === to) return asm
    const allowed = ASSEMBLY_TRANSITIONS[from] ?? []
    if (!allowed.includes(to)) throw new BadRequestException(`Transição inválida: '${from}' → '${to}'`)
    const patch: Record<string, unknown> = { status: to }
    if (to === 'montando' && !(asm as { started_at?: string }).started_at) patch.started_at = new Date().toISOString()
    if (to === 'concluido') patch.completed_at = new Date().toISOString()
    await supabaseAdmin.from('assembly_order').update(patch).eq('id', aid).eq('organization_id', orgId)

    if (to === 'cancelado') {
      await this.releaseParts(orgId, 'assembly_order', aid)
      await this.inputs.release(orgId, 'assembly_order', aid)
    }
    if (to === 'concluido') {
      await this.consumeParts(orgId, 'assembly_order', aid)
      await this.inputs.consume(orgId, 'assembly_order', aid)
      await this.creditProductStock(orgId, asm)
      await this.emit(orgId, asm.product_dev_id, 'assembly_completed' as string, { assembly_order_id: aid, qty: asm.quantity }, userId)
    }
    return this.getAssembly(orgId, aid)
  }

  /** Credita os produtos montados em products.stock (se o produto já está cadastrado).
   *  Idempotente via assembly_order.stock_movement_done. */
  private async creditProductStock(orgId: string, asm: { id: string; product_dev_id: string; quantity: number; stock_movement_done: boolean }) {
    if (asm.stock_movement_done === true) return
    const { data: dev } = await supabaseAdmin.from('product_dev').select('product_id').eq('id', asm.product_dev_id).eq('organization_id', orgId).maybeSingle()
    const productId = (dev as { product_id: string | null } | null)?.product_id
    await supabaseAdmin.from('assembly_order').update({ stock_movement_done: true }).eq('id', asm.id)
    if (!productId) { this.logger.log(`[montagem] ${asm.id.slice(0, 8)} concluída sem produto cadastrado — sem crédito de estoque vendável`); return }
    const qty = Number(asm.quantity) || 0
    const { data: prod } = await supabaseAdmin.from('products').select('stock').eq('id', productId).maybeSingle()
    const novo = (Number((prod as { stock: number | null } | null)?.stock) || 0) + qty
    await supabaseAdmin.from('products').update({ stock: novo, updated_at: new Date().toISOString() }).eq('id', productId).eq('organization_id', orgId)
    await supabaseAdmin.from('product_stock').update({ quantity: novo, updated_at: new Date().toISOString() }).eq('product_id', productId).is('platform', null)
    this.logger.log(`[montagem] +${qty} un montadas (products.stock=${novo}) p/ ${productId.slice(0, 8)}`)
  }

  // ══ Custo somado: peças + insumos de montagem ══════════════════════
  async costFromParts(orgId: string, devId: string, body: { target_margin_pct?: number } = {}) {
    const parts = await this.listParts(orgId, devId) as Array<PartRef>
    if (!parts.length) throw new BadRequestException('Sem peças cadastradas.')
    const { data: settings } = await supabaseAdmin.from('production_settings')
      .select('filament_cost_per_kg, energy_cost_per_hour, labor_cost_per_hour, packaging_cost').eq('organization_id', orgId).maybeSingle()
    const s = (settings ?? {}) as { filament_cost_per_kg?: Record<string, number>; energy_cost_per_hour?: number; labor_cost_per_hour?: number; packaging_cost?: number }
    const filamentKg = s.filament_cost_per_kg ?? {}
    const energyRate = Number(s.energy_cost_per_hour) || 0, laborRate = Number(s.labor_cost_per_hour) || 0, pkg = Number(s.packaging_cost) || 0

    const partLines: Array<{ part_id: string; name: string; qty_per_product: number; weight_g: number | null; print_minutes: number | null; unit_cost: number; line_cost: number; has_version: boolean }> = []
    for (const p of parts) {
      const m = await this.resolvePartMetrics(orgId, p.id)
      const mat = (m.material ?? '').toUpperCase()
      const filCost = m.weight_g != null ? (Number(m.weight_g) / 1000) * (Number(filamentKg[mat]) || 0) : 0
      const time = Number(m.print_time_minutes) || 0
      const unitCost = this.round2(filCost + (time / 60) * energyRate + (time / 60) * laborRate)
      const lineCost = this.round2(unitCost * Number(p.qty_per_product))
      partLines.push({ part_id: p.id, name: p.name, qty_per_product: Number(p.qty_per_product), weight_g: m.weight_g, print_minutes: m.print_time_minutes, unit_cost: unitCost, line_cost: lineCost, has_version: m.weight_g != null || m.print_time_minutes != null })
    }
    // insumos de montagem (BOM não-filamento, custo médio vivo)
    const { data: bom } = await supabaseAdmin.from('product_dev_bom').select('input_id, kind, description, quantity, unit_cost, waste_pct')
      .eq('organization_id', orgId).eq('product_dev_id', devId).is('version_id', null)
    const inputIds = (bom ?? []).map(l => (l as { input_id: string | null }).input_id).filter(Boolean) as string[]
    const costByInput = new Map<string, number>()
    if (inputIds.length) {
      const { data: inputs } = await supabaseAdmin.from('production_input').select('id, cost_per_unit').in('id', inputIds)
      for (const i of inputs ?? []) costByInput.set((i as { id: string }).id, Number((i as { cost_per_unit: number }).cost_per_unit) || 0)
    }
    const insumoLines = ((bom ?? []) as Array<{ input_id: string | null; kind: string; description: string | null; quantity: number; unit_cost: number; waste_pct: number }>)
      .filter(l => l.kind !== 'filamento' && Number(l.quantity) > 0)
      .map(l => {
        const uc = l.input_id && costByInput.has(l.input_id) ? (costByInput.get(l.input_id) as number) : Number(l.unit_cost)
        return { kind: l.kind, description: l.description, quantity: Number(l.quantity), unit_cost: uc, line_cost: this.round2(Number(l.quantity) * uc * (1 + Number(l.waste_pct) / 100)) }
      })

    const partsTotal = this.round2(partLines.reduce((a, l) => a + l.line_cost, 0))
    const insumosTotal = this.round2(insumoLines.reduce((a, l) => a + l.line_cost, 0))
    const total = this.round2(partsTotal + insumosTotal + pkg)

    const targetMargin = Math.min(Math.max(Number(body.target_margin_pct ?? 30), 0), 90)
    const suggested = Object.entries(CHANNEL_ALLIN_FEE_PCT).map(([channel, fee]) => {
      const denom = 1 - fee / 100 - targetMargin / 100
      const price = denom > 0 ? this.round2(total / denom) : 0
      const marginPct = price > 0 ? this.round2(((price - price * fee / 100 - total) / price) * 100) : 0
      return { channel, fee_pct: fee, price, margin_pct: marginPct }
    })
    await supabaseAdmin.from('product_dev').update({ estimated_cost: total }).eq('id', devId).eq('organization_id', orgId)
    return {
      cost: { total, parts_total: partsTotal, insumos_total: insumosTotal, packaging: this.round2(pkg) },
      parts: partLines, insumos: insumoLines, missing_versions: partLines.filter(l => !l.has_version).map(l => l.name),
      target_margin_pct: targetMargin, suggested_prices: suggested,
    }
  }
}
