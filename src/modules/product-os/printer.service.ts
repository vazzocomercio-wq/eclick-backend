import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'

/**
 * Product OS — Fase 4: cadastro de impressoras + economia da fábrica.
 * Payback: o custo de aquisição é um saldo a quitar; cada ordem concluída
 * credita sua contribuição. "Se pagou" quando contribuição ≥ aquisição.
 */

export interface Printer {
  id: string; organization_id: string
  name: string; brand: string | null; model: string | null
  build_volume_mm: string | null; nozzle_mm: number | null; has_ams: boolean; power_watts: number | null
  acquisition_cost: number; acquisition_date: string | null; expected_lifetime_hours: number | null
  status: 'ativa' | 'manutencao' | 'aposentada'; notes: string | null
  created_at: string; updated_at: string
}

export interface PrinterEconomics extends Printer {
  accumulated_contribution: number   // lucro acumulado que abate o investimento
  paid_pct: number | null            // % do investimento já quitado
  remaining_to_payback: number       // quanto falta pagar
  paid_off: boolean
  total_units_produced: number
  total_print_minutes: number
  active_orders: number
  depreciation_per_hour: number | null
}

@Injectable()
export class PrinterService {
  async list(orgId: string): Promise<PrinterEconomics[]> {
    const { data: printers, error } = await supabaseAdmin.from('production_printer').select('*')
      .eq('organization_id', orgId).order('created_at', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    const rows = (printers ?? []) as Printer[]
    if (!rows.length) return []

    const { data: orders } = await supabaseAdmin.from('production_order')
      .select('printer_id, status, quantity, contribution_total')
      .eq('organization_id', orgId).not('printer_id', 'is', null)
    const { data: jobs } = await supabaseAdmin.from('print_job')
      .select('printer_id, print_time_minutes, status')
      .eq('organization_id', orgId).not('printer_id', 'is', null).eq('status', 'concluido')

    return rows.map(p => this.withEconomics(p, orders ?? [], jobs ?? []))
  }

  async get(orgId: string, id: string): Promise<PrinterEconomics> {
    const { data, error } = await supabaseAdmin.from('production_printer').select('*')
      .eq('id', id).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Impressora não encontrada')
    const { data: orders } = await supabaseAdmin.from('production_order')
      .select('printer_id, status, quantity, contribution_total').eq('organization_id', orgId).eq('printer_id', id)
    const { data: jobs } = await supabaseAdmin.from('print_job')
      .select('printer_id, print_time_minutes, status').eq('organization_id', orgId).eq('printer_id', id).eq('status', 'concluido')
    return this.withEconomics(data as Printer, orders ?? [], jobs ?? [])
  }

  async create(orgId: string, dto: Partial<Printer> & { name: string }): Promise<Printer> {
    if (!dto.name?.trim()) throw new BadRequestException('Nome da impressora é obrigatório')
    const { data, error } = await supabaseAdmin.from('production_printer').insert({
      organization_id: orgId, name: dto.name.trim(), brand: dto.brand ?? null, model: dto.model ?? null,
      build_volume_mm: dto.build_volume_mm ?? null, nozzle_mm: dto.nozzle_mm ?? null, has_ams: dto.has_ams ?? false,
      power_watts: dto.power_watts ?? null, acquisition_cost: dto.acquisition_cost ?? 0,
      acquisition_date: dto.acquisition_date ?? null, expected_lifetime_hours: dto.expected_lifetime_hours ?? null,
      status: dto.status ?? 'ativa', notes: dto.notes ?? null,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar impressora: ${error?.message ?? 'sem dados'}`)
    return data as Printer
  }

  async update(orgId: string, id: string, patch: Partial<Printer>): Promise<Printer> {
    const allowed: (keyof Printer)[] = ['name', 'brand', 'model', 'build_volume_mm', 'nozzle_mm', 'has_ams', 'power_watts', 'acquisition_cost', 'acquisition_date', 'expected_lifetime_hours', 'status', 'notes']
    const safe: Record<string, unknown> = {}
    for (const k of allowed) if (k in patch) safe[k] = patch[k]
    if (Object.keys(safe).length === 0) throw new BadRequestException('Nada para atualizar')
    const { data, error } = await supabaseAdmin.from('production_printer').update(safe)
      .eq('id', id).eq('organization_id', orgId).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro: ${error?.message ?? 'não encontrado'}`)
    return data as Printer
  }

  private withEconomics(p: Printer, orders: Array<{ printer_id: string | null; status: string; quantity: number; contribution_total: number | null }>, jobs: Array<{ printer_id: string | null; print_time_minutes: number | null }>): PrinterEconomics {
    const mine = orders.filter(o => o.printer_id === p.id)
    const done = mine.filter(o => o.status === 'disponivel')
    const accumulated = round2(done.reduce((s, o) => s + (Number(o.contribution_total) || 0), 0))
    const units = done.reduce((s, o) => s + (Number(o.quantity) || 0), 0)
    const minutes = jobs.filter(j => j.printer_id === p.id).reduce((s, j) => s + (Number(j.print_time_minutes) || 0), 0)
    const active = mine.filter(o => !['disponivel', 'cancelado'].includes(o.status)).length
    const cost = Number(p.acquisition_cost) || 0
    const paidPct = cost > 0 ? Math.min(100, round2((accumulated / cost) * 100)) : null
    return {
      ...p,
      accumulated_contribution: accumulated,
      paid_pct: paidPct,
      remaining_to_payback: round2(Math.max(0, cost - accumulated)),
      paid_off: cost > 0 && accumulated >= cost,
      total_units_produced: units,
      total_print_minutes: minutes,
      active_orders: active,
      depreciation_per_hour: p.expected_lifetime_hours && p.expected_lifetime_hours > 0 ? round2(cost / p.expected_lifetime_hours) : null,
    }
  }
}

function round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }
