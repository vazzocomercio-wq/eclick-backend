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
  name: string
  material: string | null
  color: string | null
  unit: 'g' | 'kg' | 'un' | 'm'
  quantity: number
  reserved_quantity: number
  reorder_threshold: number
  cost_per_unit: number
  is_active: boolean
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

  async create(orgId: string, dto: {
    kind?: string; name: string; material?: string; color?: string; unit?: string
    quantity?: number; reorder_threshold?: number; cost_per_unit?: number
  }): Promise<ProductionInput> {
    if (!dto.name?.trim()) throw new BadRequestException('Nome do insumo é obrigatório')
    const { data, error } = await supabaseAdmin.from('production_input').insert({
      organization_id: orgId,
      kind: dto.kind ?? 'filamento',
      name: dto.name.trim(),
      material: dto.material ?? null,
      color: dto.color ?? null,
      unit: dto.unit ?? 'g',
      quantity: dto.quantity ?? 0,
      reorder_threshold: dto.reorder_threshold ?? 0,
      cost_per_unit: dto.cost_per_unit ?? 0,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar insumo: ${error?.message ?? 'sem dados'}`)
    return data as ProductionInput
  }

  async update(orgId: string, id: string, patch: Partial<ProductionInput>): Promise<ProductionInput> {
    const allowed: (keyof ProductionInput)[] = ['name', 'material', 'color', 'unit', 'reorder_threshold', 'cost_per_unit', 'is_active']
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin.from('production_input').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    return data as ProductionInput
  }

  /** Reposição/ajuste manual do estoque físico. */
  async movement(orgId: string, id: string, body: { type: 'in' | 'adjust'; quantity: number; notes?: string }, userId: string | null): Promise<ProductionInput> {
    const input = await this.getOne(orgId, id)
    const qty = Math.max(0, Number(body.quantity) || 0)
    const novaQtd = body.type === 'adjust' ? qty : Number(input.quantity) + qty
    await supabaseAdmin.from('production_input').update({
      quantity: novaQtd, last_movement_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', id).eq('organization_id', orgId)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: id, movement_type: body.type, quantity: qty,
      balance_after: novaQtd, notes: body.notes ?? null, created_by: userId,
    })
    return { ...input, quantity: novaQtd }
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

  /** Consome (baixa física) o que foi reservado p/ a ref. Idempotente. */
  async consume(orgId: string, refType: string, refId: string, actualQty?: number): Promise<void> {
    const { data: reserveMov } = await supabaseAdmin.from('production_input_movement').select('input_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve').maybeSingle()
    if (!reserveMov) return
    const inputId = (reserveMov as { input_id: string }).input_id
    const reserved = Number((reserveMov as { quantity: number }).quantity)
    const { data: consumed } = await supabaseAdmin.from('production_input_movement').select('id')
      .eq('input_id', inputId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'consume').maybeSingle()
    if (consumed) return
    const physical = Math.max(0, Number(actualQty ?? reserved))
    const { data: input } = await supabaseAdmin.from('production_input').select('*').eq('id', inputId).maybeSingle()
    if (!input) return
    const i = input as ProductionInput
    const novaQtd = Math.max(0, Number(i.quantity) - physical)
    const novaRes = Math.max(0, Number(i.reserved_quantity) - reserved)
    await supabaseAdmin.from('production_input').update({
      quantity: novaQtd, reserved_quantity: novaRes, last_movement_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', inputId)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: inputId, movement_type: 'consume', quantity: physical,
      balance_after: novaQtd, reference_type: refType, reference_id: refId, notes: 'Consumo na conclusão da produção',
    })
  }

  /** Libera a reserva sem baixa física (cancelamento de ordem). Idempotente. */
  async release(orgId: string, refType: string, refId: string): Promise<void> {
    const { data: reserveMov } = await supabaseAdmin.from('production_input_movement').select('input_id, quantity')
      .eq('organization_id', orgId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'reserve').maybeSingle()
    if (!reserveMov) return
    const inputId = (reserveMov as { input_id: string }).input_id
    const reserved = Number((reserveMov as { quantity: number }).quantity)
    const { data: released } = await supabaseAdmin.from('production_input_movement').select('id')
      .eq('input_id', inputId).eq('reference_type', refType).eq('reference_id', refId).eq('movement_type', 'release').maybeSingle()
    if (released) return
    const { data: input } = await supabaseAdmin.from('production_input').select('reserved_quantity').eq('id', inputId).maybeSingle()
    if (!input) return
    const novaRes = Math.max(0, Number((input as { reserved_quantity: number }).reserved_quantity) - reserved)
    await supabaseAdmin.from('production_input').update({ reserved_quantity: novaRes, updated_at: new Date().toISOString() }).eq('id', inputId)
    await supabaseAdmin.from('production_input_movement').insert({
      organization_id: orgId, input_id: inputId, movement_type: 'release', quantity: reserved,
      reference_type: refType, reference_id: refId, notes: 'Liberação de reserva (cancelamento)',
    })
  }

  private async getOne(orgId: string, id: string): Promise<ProductionInput> {
    const { data, error } = await supabaseAdmin.from('production_input').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Insumo não encontrado')
    return data as ProductionInput
  }
}
