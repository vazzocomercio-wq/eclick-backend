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

  /** Painel analítico de UMA impressora: confiabilidade, horas, R$/hora real,
   *  payback, filamento e breakdown por produto. */
  async analytics(orgId: string, id: string) {
    const printer = await this.get(orgId, id)  // já traz a economia/payback
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString()

    const [jobsR, ordersR] = await Promise.all([
      supabaseAdmin.from('print_job').select('status, print_time_minutes, filament_used_g').eq('organization_id', orgId).eq('printer_id', id),
      supabaseAdmin.from('production_order').select('order_number, product_dev_id, status, quantity, contribution_total, completed_at, actual_time_minutes, estimated_time_minutes, actual_filament_g, estimated_filament_g').eq('organization_id', orgId).eq('printer_id', id),
    ])
    const jobs = (jobsR.data ?? []) as Array<{ status: string; print_time_minutes: number | null; filament_used_g: number | null }>
    const orders = (ordersR.data ?? []) as Array<{ order_number: number; product_dev_id: string; status: string; quantity: number; contribution_total: number | null; completed_at: string | null; actual_time_minutes: number | null; estimated_time_minutes: number | null; actual_filament_g: number | null; estimated_filament_g: number | null }>

    const jobsDone = jobs.filter(j => j.status === 'concluido').length
    const jobsFailed = jobs.filter(j => j.status === 'falhou').length
    const finished = jobsDone + jobsFailed
    const done = orders.filter(o => o.status === 'disponivel')

    // nomes dos produtos
    const devIds = [...new Set(done.map(o => o.product_dev_id))]
    const devs = devIds.length ? (await supabaseAdmin.from('product_dev').select('id, name').in('id', devIds)).data ?? [] : []
    const nameById = new Map(devs.map(d => [(d as { id: string }).id, (d as { name: string }).name]))

    // breakdown por produto
    const byProductMap = new Map<string, { units: number; minutes: number; contribution: number }>()
    let filamentUsed = 0
    for (const o of done) {
      const cur = byProductMap.get(o.product_dev_id) ?? { units: 0, minutes: 0, contribution: 0 }
      cur.units += Number(o.quantity) || 0
      cur.minutes += Number(o.actual_time_minutes ?? o.estimated_time_minutes) || 0
      cur.contribution += Number(o.contribution_total) || 0
      byProductMap.set(o.product_dev_id, cur)
      filamentUsed += Number(o.actual_filament_g ?? o.estimated_filament_g) || 0
    }
    const byProduct = [...byProductMap.entries()].map(([devId, v]) => ({
      product_dev_id: devId, name: nameById.get(devId) ?? '—',
      units: v.units, hours: round2(v.minutes / 60), contribution: round2(v.contribution),
      profit_per_hour: v.minutes > 0 ? round2(v.contribution / (v.minutes / 60)) : null,
    })).sort((a, b) => (b.profit_per_hour ?? -1) - (a.profit_per_hour ?? -1))

    const hours = printer.total_print_minutes / 60
    const daysOwned = printer.acquisition_date ? Math.max(1, Math.floor((Date.now() - new Date(printer.acquisition_date).getTime()) / 86400_000)) : null

    return {
      printer: {
        id: printer.id, name: printer.name, brand: printer.brand, model: printer.model, status: printer.status,
        build_volume_mm: printer.build_volume_mm, has_ams: printer.has_ams,
        acquisition_cost: printer.acquisition_cost, acquisition_date: printer.acquisition_date,
      },
      performance: {
        jobs_total: jobs.length, jobs_done: jobsDone, jobs_failed: jobsFailed,
        success_rate_pct: finished > 0 ? round2((jobsDone / finished) * 100) : null,
        total_print_hours: round2(hours),
        avg_minutes_per_job: jobsDone > 0 ? round2(printer.total_print_minutes / jobsDone) : null,
        filament_used_g: round2(filamentUsed),
      },
      throughput: {
        units_produced: printer.total_units_produced,
        units_30d: done.filter(o => o.completed_at && o.completed_at >= since30).reduce((s, o) => s + (Number(o.quantity) || 0), 0),
        orders_done: done.length, orders_active: printer.active_orders,
      },
      economics: {
        accumulated_contribution: printer.accumulated_contribution, paid_pct: printer.paid_pct,
        remaining_to_payback: printer.remaining_to_payback, paid_off: printer.paid_off,
        revenue_per_hour: hours > 0 ? round2(printer.accumulated_contribution / hours) : null,
        depreciation_per_hour: printer.depreciation_per_hour,
        days_owned: daysOwned,
        utilization_pct: daysOwned ? round2(Math.min(100, (hours / (daysOwned * 24)) * 100)) : null,
      },
      by_product: byProduct,
      recent_orders: orders.slice().sort((a, b) => b.order_number - a.order_number).slice(0, 8).map(o => ({
        order_number: o.order_number, name: nameById.get(o.product_dev_id) ?? '—', status: o.status,
        quantity: o.quantity, contribution_total: o.contribution_total, completed_at: o.completed_at,
      })),
    }
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
