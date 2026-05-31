import { Injectable, HttpException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

// ── tipos ────────────────────────────────────────────────────────────────────

export type Recurrence = 'monthly' | 'once' | 'annual'
export type AllocationDriver =
  | 'contribution_margin' | 'revenue' | 'units' | 'orders' | 'equal' | 'manual'

export interface CreateOperatingCostDto {
  label: string
  category?: string
  amount: number                 // R$
  recurrence?: Recurrence
  allocation_driver?: AllocationDriver
  valid_from?: string            // 'YYYY-MM-DD'
  valid_to?: string | null
  notes?: string | null
}
export type UpdateOperatingCostDto = Partial<CreateOperatingCostDto> & { active?: boolean }

export interface OperatingCostRow {
  id: string
  organization_id: string
  label: string
  category: string
  amount: number
  recurrence: Recurrence
  allocation_driver: AllocationDriver
  valid_from: string
  valid_to: string | null
  active: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

const COLS =
  'id, organization_id, label, category, amount, recurrence, allocation_driver, valid_from, valid_to, active, notes, created_at, updated_at'

/** Categorias sugeridas no front (livre — não é enum no banco). */
export const OPERATING_COST_CATEGORIES = [
  'aluguel', 'folha', 'pro_labore', 'energia', 'agua', 'internet_telefone',
  'software', 'contabilidade', 'impostos_fixos', 'manutencao', 'marketing_fixo', 'outros',
] as const

/**
 * Custos fixos/operacionais + meta de lucro consolidado. Fundação da Central
 * de Resultado (DRE viva). Tudo via supabaseAdmin filtrando por org (padrão do
 * módulo financeiro). O motor de DRE/rateio (Fase 2) consome `getMonthlyTotal`.
 */
@Injectable()
export class OperatingCostsService {
  // ── CRUD ────────────────────────────────────────────────────────────────

  async list(orgId: string, opts: { active?: boolean; category?: string } = {}): Promise<OperatingCostRow[]> {
    let q = supabaseAdmin
      .from('operating_costs')
      .select(COLS)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
    if (opts.active !== undefined) q = q.eq('active', opts.active)
    if (opts.category) q = q.eq('category', opts.category)
    const { data, error } = await q
    if (error) throw new HttpException(error.message, 500)
    return (data ?? []) as OperatingCostRow[]
  }

  async create(orgId: string, dto: CreateOperatingCostDto): Promise<OperatingCostRow> {
    if (!dto.label?.trim()) throw new HttpException('label obrigatório', 400)
    if (!(dto.amount >= 0) || !Number.isFinite(dto.amount)) throw new HttpException('amount inválido', 400)
    const row = {
      organization_id: orgId,
      label: dto.label.trim(),
      category: dto.category ?? 'outros',
      amount: dto.amount,
      recurrence: dto.recurrence ?? 'monthly',
      allocation_driver: dto.allocation_driver ?? 'contribution_margin',
      valid_from: dto.valid_from ?? undefined,
      valid_to: dto.valid_to ?? null,
      notes: dto.notes ?? null,
    }
    const { data, error } = await supabaseAdmin
      .from('operating_costs')
      .insert(row)
      .select(COLS)
      .single()
    if (error) throw new HttpException(error.message, 500)
    return data as OperatingCostRow
  }

  async update(orgId: string, id: string, dto: UpdateOperatingCostDto): Promise<OperatingCostRow> {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    for (const k of ['label', 'category', 'amount', 'recurrence', 'allocation_driver', 'valid_from', 'valid_to', 'active', 'notes'] as const) {
      if (dto[k] !== undefined) patch[k] = dto[k]
    }
    const { data, error } = await supabaseAdmin
      .from('operating_costs')
      .update(patch)
      .eq('organization_id', orgId)
      .eq('id', id)
      .select(COLS)
      .maybeSingle()
    if (error) throw new HttpException(error.message, 500)
    if (!data) throw new NotFoundException('Custo não encontrado')
    return data as OperatingCostRow
  }

  /** Soft-delete: preserva histórico p/ DRE de meses passados. */
  async remove(orgId: string, id: string): Promise<{ ok: true }> {
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await supabaseAdmin
      .from('operating_costs')
      .update({ active: false, valid_to: today, updated_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('id', id)
    if (error) throw new HttpException(error.message, 500)
    return { ok: true }
  }

  // ── Total mensal (consumido pelo motor de DRE — Fase 2) ──────────────────

  /**
   * Soma dos custos fixos NORMALIZADOS pra o mês `ym` ('YYYY-MM', default mês
   * atual): mensal as-is, anual ÷12, única só no mês do valid_from. Respeita a
   * vigência (valid_from/valid_to) e active.
   */
  async getMonthlyTotal(orgId: string, ym?: string): Promise<{ month: string; total: number; by_category: Record<string, number> }> {
    const month = ym ?? new Date().toISOString().slice(0, 7)
    const monthStart = `${month}-01`
    const monthEnd = endOfMonth(month)

    const { data, error } = await supabaseAdmin
      .from('operating_costs')
      .select('amount, recurrence, category, valid_from, valid_to')
      .eq('organization_id', orgId)
      .eq('active', true)
    if (error) throw new HttpException(error.message, 500)

    let total = 0
    const byCat: Record<string, number> = {}
    for (const r of (data ?? []) as Array<{ amount: number; recurrence: Recurrence; category: string; valid_from: string; valid_to: string | null }>) {
      // vigência: começou até o fim do mês E (não terminou OU terminou depois do início do mês)
      if (r.valid_from > monthEnd) continue
      if (r.valid_to && r.valid_to < monthStart) continue
      let monthly = 0
      if (r.recurrence === 'monthly') monthly = Number(r.amount)
      else if (r.recurrence === 'annual') monthly = Number(r.amount) / 12
      else if (r.recurrence === 'once') monthly = r.valid_from.slice(0, 7) === month ? Number(r.amount) : 0
      monthly = Math.round(monthly * 100) / 100
      total += monthly
      byCat[r.category] = Math.round(((byCat[r.category] ?? 0) + monthly) * 100) / 100
    }
    return { month, total: Math.round(total * 100) / 100, by_category: byCat }
  }

  // ── Config de resultado (meta de líquido consolidado) ────────────────────

  async getResultConfig(orgId: string): Promise<{ target_net_margin_pct: number }> {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('target_net_margin_pct')
      .eq('id', orgId)
      .single()
    if (error) throw new HttpException(error.message, 500)
    return { target_net_margin_pct: Number((data as { target_net_margin_pct: number | null })?.target_net_margin_pct ?? 15) }
  }

  async setResultConfig(orgId: string, pct: number): Promise<{ target_net_margin_pct: number }> {
    if (!Number.isFinite(pct) || pct < 0 || pct > 95) throw new HttpException('target_net_margin_pct inválido (0–95)', 400)
    const { error } = await supabaseAdmin
      .from('organizations')
      .update({ target_net_margin_pct: pct })
      .eq('id', orgId)
    if (error) throw new HttpException(error.message, 500)
    return { target_net_margin_pct: pct }
  }
}

function endOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${ym}-${String(last).padStart(2, '0')}`
}
