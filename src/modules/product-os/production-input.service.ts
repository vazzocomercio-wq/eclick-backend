import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Product OS — estoque de INSUMOS (filamento, embalagem, etiqueta).
 * Espelha o padrão do ledger do Icarus (master + movimentos), mas isolado:
 * NÃO toca product_stock. Reserva ao enfileirar produção, consome ao concluir.
 */

export interface ProductionInput {
  id: string
  organization_id: string
  kind: 'filamento' | 'embalagem' | 'etiqueta' | 'outro'
  sku: string | null
  name: string
  description: string | null
  material: string | null      // tipo (PLA, PETG, ABS…)
  color: string | null
  color_hex: string | null
  brand: string | null
  supplier: string | null
  diameter_mm: number | null
  spool_weight_g: number | null
  unit: 'g' | 'kg' | 'un' | 'm'
  quantity: number
  reserved_quantity: number
  reorder_threshold: number
  cost_per_unit: number         // CUSTO MÉDIO PONDERADO (recalculado a cada entrada)
  is_active: boolean
  notes: string | null
  last_movement_at: string | null
  created_at: string
  updated_at: string
}

@Injectable()
export class ProductionInputService {
  private readonly logger = new Logger(ProductionInputService.name)

  async list(orgId: string, opts: { kind?: string; lowStock?: boolean } = {}): Promise<Array<ProductionInput & { available: number; alert: boolean }>> {
    let q = supabaseAdmin.from('production_input').select('*')
      .eq('organization_id', orgId).eq('is_active', true)
      .order('kind', { ascending: true }).order('name', { ascending: true })
    if (opts.kind) q = q.eq('kind', opts.kind)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    let rows = (data ?? []).map(r => {
      const i = r as ProductionInput
      const available = Number(i.quantity) - Number(i.reserved_quantity)
      const alert = i.reorder_threshold > 0 && available <= i.reorder_threshold
      return { ...i, available, alert }
    })
    if (opts.lowStock) rows = rows.filter(r => r.alert)
    return rows
  }

  async create(orgId: string, dto: Partial<ProductionInput> & { name: string }): Promise<ProductionInput> {
    if (!dto.name?.trim()) throw new BadRequestException('Nome do insumo é obrigatório')
    const { data, error } = await supabaseAdmin.from('production_input').insert({
      organization_id: orgId,
      kind: dto.kind ?? 'filamento',
      sku: dto.sku ?? null,
      name: dto.name.trim(),
      description: dto.description ?? null,
      material: dto.material ?? null,
      color: dto.color ?? null,
      color_hex: dto.color_hex ?? null,
      brand: dto.brand ?? null,
      supplier: dto.supplier ?? null,
      diameter_mm: dto.diameter_mm ?? null,
      spool_weight_g: dto.spool_weight_g ?? null,
      unit: dto.unit ?? 'g',
      quantity: dto.quantity ?? 0,
      reorder_threshold: dto.reorder_threshold ?? 0,
      cost_per_unit: dto.cost_per_unit ?? 0,   // custo do lote inicial = médio inicial
      notes: dto.notes ?? null,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar insumo: ${error?.message ?? 'sem dados'}`)
    return data as ProductionInput
  }

  async update(orgId: string, id: string, patch: Partial<ProductionInput>): Promise<ProductionInput> {
    const allowed: (keyof ProductionInput)[] = ['kind', 'sku', 'name', 'description', 'material', 'color', 'color_hex', 'brand', 'supplier', 'diameter_mm', 'spool_weight_g', 'unit', 'reorder_threshold', 'cost_per_unit', 'is_active', 'notes']
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin.from('production_input').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    return data as ProductionInput
  }

  /** Exclui o insumo de vez (+ histórico de movimentações). Bloqueia se estiver
   *  reservado por uma ordem ou em uso numa composição (BOM) — nesses casos o
   *  certo é desativar, não apagar. */
  async deleteInput(orgId: string, id: string): Promise<{ deleted: boolean }> {
    const input = await this.getOne(orgId, id)
    if (Number(input.reserved_quantity) > 0) {
      throw new BadRequestException('Insumo reservado por uma ordem de produção — conclua/cancele a ordem antes de excluir (ou desative).')
    }
    const { data: bom } = await supabaseAdmin.from('product_dev_bom').select('id').eq('input_id', id).limit(1).maybeSingle()
    if (bom) throw new BadRequestException('Insumo em uso numa composição (BOM) de produto — remova de lá ou desative em vez de excluir.')
    await supabaseAdmin.from('production_input_movement').delete().eq('organization_id', orgId).eq('input_id', id)
    const { error } = await supabaseAdmin.from('production_input').delete().eq('id', id).eq('organization_id', orgId)
    if (error) throw new BadRequestException(`Erro ao excluir: ${error.message}`)
    return { deleted: true }
  }

  /** Reposição/ajuste do estoque. Entrada com preço recalcula o CUSTO MÉDIO
   *  PONDERADO: (qtd_atual×custo_atual + qtd_entrada×custo_entrada) / total. */
  async movement(orgId: string, id: string, body: { type: 'in' | 'adjust'; quantity: number; unit_cost?: number; notes?: string }, userId: string | null): Promise<ProductionInput> {
    const input = await this.getOne(orgId, id)
    const qty = Math.max(0, Number(body.quantity) || 0)
    const novaQtd = body.type === 'adjust' ? qty : Number(input.quantity) + qty
    let novoCusto = Number(input.cost_per_unit) || 0
    if (body.type === 'in' && body.unit_cost != null && qty > 0) {
      const curQty = Math.max(0, Number(input.quantity) || 0)
      const inCost = Math.max(0, Number(body.unit_cost) || 0)
      const total = curQty + qty
      novoCusto = total > 0 ? Math.round(((curQty * novoCusto + qty * inCost) / total) * 1e6) / 1e6 : inCost // 6 casas: custo/g é pequeno
    }
    await supabaseAdmin.from('production_input').update({
      quantity: novaQtd, cost_per_unit: novoCusto, last_movement_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('organization_id', orgId)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: id, movement_type: body.type, quantity: qty,
      balance_after: novaQtd, unit_cost: body.unit_cost ?? null, notes: body.notes ?? null, created_by: userId,
    })
    return { ...input, quantity: novaQtd, cost_per_unit: novoCusto }
  }

  async listMovements(orgId: string, id: string) {
    const { data, error } = await supabaseAdmin.from('production_input_movement').select('*')
      .eq('organization_id', orgId).eq('input_id', id)
      .order('created_at', { ascending: false }).limit(100)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  // ── reserva/consumo p/ ordens de produção ─────────────────────────

  /** Reserva `quantity` do 1º insumo de filamento ativo que casa com o material.
   *  Idempotente por (refType, refId). Retorna o input_id reservado ou null. */
  async reserveByMaterial(orgId: string, material: string | null, quantity: number, refType: string, refId: string): Promise<{ inputId: string } | null> {
    const qty = Math.max(0, Number(quantity) || 0)
    if (qty <= 0) return null
    let q = supabaseAdmin.from('production_input').select('*')
      .eq('organization_id', orgId).eq('kind', 'filamento').eq('is_active', true)
      .order('quantity', { ascending: false }).limit(1)
    if (material) q = q.eq('material', material.toUpperCase())
    const { data } = await q
    const input = (data ?? [])[0] as ProductionInput | undefined
    if (!input) { this.logger.warn(`[insumo] sem filamento ${material ?? ''} p/ reservar (org ${orgId.slice(0, 8)})`); return null }
    // idempotência
    const { data: existing } = await supabaseAdmin.from('production_input_movement').select('id')
      .eq('input_id', input.id).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve').maybeSingle()
    if (existing) return { inputId: input.id }
    await supabaseAdmin.from('production_input').update({
      reserved_quantity: Number(input.reserved_quantity) + qty, updated_at: new Date().toISOString(),
    }).eq('id', input.id)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: input.id, movement_type: 'reserve', quantity: qty,
      reference_type: refType, reference_id: refId, notes: 'Reserva p/ ordem de produção',
    })
    return { inputId: input.id }
  }

  /** Reserva `quantity` de um insumo ESPECÍFICO (linha de BOM/composição).
   *  Idempotente por (refType, refId, inputId). Retorna true se a reserva existe. */
  async reserveInput(orgId: string, inputId: string, quantity: number, refType: string, refId: string): Promise<boolean> {
    const qty = Math.max(0, Number(quantity) || 0)
    if (qty <= 0) return false
    const { data: existing } = await supabaseAdmin.from('production_input_movement').select('id')
      .eq('input_id', inputId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve').maybeSingle()
    if (existing) return true
    const { data: input } = await supabaseAdmin.from('production_input').select('reserved_quantity')
      .eq('id', inputId).eq('organization_id', orgId).maybeSingle()
    if (!input) { this.logger.warn(`[insumo] insumo ${inputId.slice(0, 8)} não encontrado p/ reservar (org ${orgId.slice(0, 8)})`); return false }
    await supabaseAdmin.from('production_input').update({
      reserved_quantity: Number((input as { reserved_quantity: number }).reserved_quantity) + qty, updated_at: new Date().toISOString(),
    }).eq('id', inputId)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: inputId, movement_type: 'reserve', quantity: qty,
      reference_type: refType, reference_id: refId, notes: 'Reserva de composição (BOM) p/ ordem de produção',
    })
    return true
  }

  /** Consome (baixa física) TODOS os insumos reservados p/ a ref. Idempotente por insumo.
   *  `filamentActualG` (peso real) só sobrepõe quando há UM único filamento reservado. */
  async consume(orgId: string, refType: string, refId: string, filamentActualG?: number): Promise<void> {
    const { data: reserves } = await supabaseAdmin.from('production_input_movement').select('input_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve')
    const list = (reserves ?? []) as Array<{ input_id: string; quantity: number }>
    if (!list.length) return
    const inputIds = [...new Set(list.map(r => r.input_id))]
    const { data: inputsData } = await supabaseAdmin.from('production_input').select('*').in('id', inputIds)
    const inputMap = new Map((inputsData ?? []).map(r => [(r as ProductionInput).id, r as ProductionInput]))
    const filamentCount = list.filter(r => inputMap.get(r.input_id)?.kind === 'filamento').length
    for (const rm of list) {
      const inputId = rm.input_id
      const reserved = Number(rm.quantity)
      const { data: consumed } = await supabaseAdmin.from('production_input_movement').select('id')
        .eq('input_id', inputId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'consume').maybeSingle()
      if (consumed) continue
      const i = inputMap.get(inputId)
      if (!i) continue
      const physical = (i.kind === 'filamento' && filamentCount === 1 && filamentActualG != null)
        ? Math.max(0, Number(filamentActualG)) : Math.max(0, reserved)
      const novaQtd = Math.max(0, Number(i.quantity) - physical)
      const novaRes = Math.max(0, Number(i.reserved_quantity) - reserved)
      await supabaseAdmin.from('production_input').update({
        quantity: novaQtd, reserved_quantity: novaRes, last_movement_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', inputId)
      await supabaseAdmin.from('production_input_movement').insert({
        organization_id: orgId, input_id: inputId, movement_type: 'consume', quantity: physical,
        balance_after: novaQtd, unit_cost: Number(i.cost_per_unit) || 0,   // custo médio no momento do consumo (custo real)
        reference_type: refType, reference_id: refId, notes: 'Consumo na conclusão da produção',
      })
    }
  }

  /** Libera TODAS as reservas sem baixa física (cancelamento de ordem). Idempotente por insumo. */
  async release(orgId: string, refType: string, refId: string): Promise<void> {
    const { data: reserves } = await supabaseAdmin.from('production_input_movement').select('input_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve')
    const list = (reserves ?? []) as Array<{ input_id: string; quantity: number }>
    if (!list.length) return
    for (const rm of list) {
      const inputId = rm.input_id
      const reserved = Number(rm.quantity)
      const { data: released } = await supabaseAdmin.from('production_input_movement').select('id')
        .eq('input_id', inputId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'release').maybeSingle()
      if (released) continue
      const { data: input } = await supabaseAdmin.from('production_input').select('reserved_quantity').eq('id', inputId).maybeSingle()
      if (!input) continue
      const novaRes = Math.max(0, Number((input as { reserved_quantity: number }).reserved_quantity) - reserved)
      await supabaseAdmin.from('production_input').update({ reserved_quantity: novaRes, updated_at: new Date().toISOString() }).eq('id', inputId)
      await supabaseAdmin.from('production_input_movement').insert({
        organization_id: orgId, input_id: inputId, movement_type: 'release', quantity: reserved,
        reference_type: refType, reference_id: refId, notes: 'Liberação de reserva (cancelamento)',
      })
    }
  }

  private async getOne(orgId: string, id: string): Promise<ProductionInput> {
    const { data, error } = await supabaseAdmin.from('production_input').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Insumo não encontrado')
    return data as ProductionInput
  }

  // ══ Filamento carregado na impressora (rastreio por rolo) ══════════

  /** Monta um filamento na impressora: fecha a sessão anterior (se houver) e
   *  abre uma nova. A partir daí, o consumo daquela máquina debita ESTE rolo. */
  async loadFilament(orgId: string, printerId: string, inputId: string, slot: number, loadedG: number | null, userId: string | null) {
    const input = await this.getOne(orgId, inputId)
    if (input.kind !== 'filamento') throw new BadRequestException('Só filamento pode ser carregado na impressora.')
    if (!input.is_active) throw new BadRequestException('Esse insumo está inativo.')
    const s = Math.max(0, Math.floor(Number(slot) || 0))
    // fecha a sessão aberta dessa bandeja
    await supabaseAdmin.from('printer_loaded_filament')
      .update({ unloaded_at: new Date().toISOString() })
      .eq('organization_id', orgId).eq('printer_id', printerId).eq('slot', s).is('unloaded_at', null)
    const { data, error } = await supabaseAdmin.from('printer_loaded_filament').insert({
      organization_id: orgId, printer_id: printerId, input_id: inputId, slot: s,
      loaded_g: loadedG ?? (Number(input.spool_weight_g) || null), loaded_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao carregar filamento: ${error?.message ?? 'sem dados'}`)
    return this.getLoaded(orgId, printerId)
  }

  /** Tira o filamento da bandeja (fecha a sessão, sem montar outro). */
  async unloadFilament(orgId: string, printerId: string, slot: number, _userId: string | null) {
    const s = Math.max(0, Math.floor(Number(slot) || 0))
    await supabaseAdmin.from('printer_loaded_filament')
      .update({ unloaded_at: new Date().toISOString() })
      .eq('organization_id', orgId).eq('printer_id', printerId).eq('slot', s).is('unloaded_at', null)
    return this.getLoaded(orgId, printerId)
  }

  /** Filamento(s) montado(s) agora na impressora, com dados do insumo. */
  async getLoaded(orgId: string, printerId: string) {
    const { data, error } = await supabaseAdmin.from('printer_loaded_filament')
      .select('id, slot, loaded_at, loaded_g, consumed_g, input:input_id(id, name, material, color, color_hex, unit, quantity, reserved_quantity, cost_per_unit, spool_weight_g)')
      .eq('organization_id', orgId).eq('printer_id', printerId).is('unloaded_at', null).order('slot', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return (data ?? []).map(r => {
      const x = r as { input: unknown }
      const inp = (Array.isArray(x.input) ? x.input[0] : x.input) as { quantity: number; reserved_quantity: number } | null
      return { ...r, input: inp, available: inp ? Math.round((Number(inp.quantity) - Number(inp.reserved_quantity)) * 1e6) / 1e6 : 0 }
    })
  }

  /** Histórico de rolos montados nesta impressora (rendimento por rolo). */
  async loadHistory(orgId: string, printerId: string) {
    const { data, error } = await supabaseAdmin.from('printer_loaded_filament')
      .select('id, slot, loaded_at, unloaded_at, loaded_g, consumed_g, input:input_id(name, color, cost_per_unit)')
      .eq('organization_id', orgId).eq('printer_id', printerId).order('loaded_at', { ascending: false }).limit(50)
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  /** input_id do rolo montado (bandeja 0 por padrão). Opcionalmente exige o material. */
  async loadedInputId(orgId: string, printerId: string, material?: string | null): Promise<string | null> {
    const { data } = await supabaseAdmin.from('printer_loaded_filament')
      .select('input_id, input:input_id(material)')
      .eq('organization_id', orgId).eq('printer_id', printerId).is('unloaded_at', null).order('slot', { ascending: true }).limit(1).maybeSingle()
    if (!data) return null
    const row = data as { input_id: string; input: unknown }
    if (material) {
      const inp = (Array.isArray(row.input) ? row.input[0] : row.input) as { material: string | null } | null
      if (inp?.material && inp.material.toUpperCase() !== material.toUpperCase()) return null
    }
    return row.input_id
  }

  /** Soma gramas na conta da sessão aberta (só relatório — NÃO mexe no estoque,
   *  que já foi baixado pela consume da ordem). Idempotência: chamada 1×/ordem. */
  async bumpLoadedSession(orgId: string, printerId: string, grams: number) {
    const g = Math.max(0, Number(grams) || 0)
    if (g <= 0) return
    const { data } = await supabaseAdmin.from('printer_loaded_filament')
      .select('id, consumed_g').eq('organization_id', orgId).eq('printer_id', printerId).is('unloaded_at', null).order('slot', { ascending: true }).limit(1).maybeSingle()
    if (!data) return
    const cur = data as { id: string; consumed_g: number }
    await supabaseAdmin.from('printer_loaded_filament')
      .update({ consumed_g: Math.round((Number(cur.consumed_g) + g) * 1e6) / 1e6 }).eq('id', cur.id)
  }

  /** Uso AVULSO (impressão fora de ordem): baixa o rolo montado + soma na sessão. */
  async logManualUsage(orgId: string, printerId: string, grams: number, notes: string | null, userId: string | null) {
    const g = Math.max(0, Number(grams) || 0)
    if (g <= 0) throw new BadRequestException('Informe as gramas usadas.')
    const inputId = await this.loadedInputId(orgId, printerId)
    if (!inputId) throw new BadRequestException('Nenhum filamento montado nesta impressora — carregue um antes de registrar uso.')
    const input = await this.getOne(orgId, inputId)
    const novaQtd = Math.max(0, Math.round((Number(input.quantity) - g) * 1e6) / 1e6)
    await supabaseAdmin.from('production_input').update({
      quantity: novaQtd, last_movement_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', inputId).eq('organization_id', orgId)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: inputId, movement_type: 'consume', quantity: g, balance_after: novaQtd,
      unit_cost: Number(input.cost_per_unit) || 0, reference_type: 'printer_usage', reference_id: printerId,
      notes: notes ?? 'Uso avulso na impressora', created_by: userId,
    })
    await this.bumpLoadedSession(orgId, printerId, g)
    return this.getLoaded(orgId, printerId)
  }
}
