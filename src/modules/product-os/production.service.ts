import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common'
import { supabaseAdmin } from '../../common/supabase'
import { StockService } from '../stock/stock.service'
import { ProductionInputService } from './production-input.service'

/**
 * Product OS — Fase 2: BOM detalhado, ordem de produção, fila de impressão e
 * qualidade. Reserva insumos ao enfileirar e, ao concluir, baixa insumos +
 * alimenta o estoque de produto acabado (Icarus) via StockService.
 */

const CHANNEL_ALLIN_FEE_PCT: Record<string, number> = {
  mercado_livre: 24.5, shopee: 31.6, tiktok: 8, loja: 0,
}

const ORDER_TRANSITIONS: Record<string, string[]> = {
  fila:        ['imprimindo', 'cancelado'],
  imprimindo:  ['pausado', 'falhou', 'acabamento', 'cancelado'],
  pausado:     ['imprimindo', 'cancelado'],
  falhou:      ['reimpressao', 'cancelado'],
  reimpressao: ['imprimindo', 'cancelado'],
  acabamento:  ['qualidade', 'cancelado'],
  qualidade:   ['embalado', 'falhou'],
  embalado:    ['disponivel'],
  disponivel:  [],
  cancelado:   [],
}

interface VersionMetrics { weight_g: number | null; print_time_minutes: number | null; material: string | null }

@Injectable()
export class ProductionService {
  private readonly logger = new Logger(ProductionService.name)

  constructor(
    private readonly stock: StockService,
    private readonly inputs: ProductionInputService,
  ) {}

  private round2(n: number): number { return Math.round((Number(n) || 0) * 100) / 100 }

  private async emit(orgId: string, devId: string, type: string, payload: Record<string, unknown>, userId?: string | null) {
    await supabaseAdmin.from('product_dev_event').insert({
      organization_id: orgId, product_dev_id: devId, event_type: type, payload, actor_id: userId ?? null,
    }).then(() => {}, () => {})
  }

  // ── BOM ───────────────────────────────────────────────────────────
  async getBom(orgId: string, devId: string, versionId?: string) {
    let q = supabaseAdmin.from('product_dev_bom').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('sort_order', { ascending: true })
    if (versionId) q = q.eq('version_id', versionId)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async replaceBom(orgId: string, devId: string, userId: string | null, body: {
    version_id?: string
    lines: Array<{ kind: string; description?: string; input_id?: string; quantity: number; unit?: string; unit_cost?: number; waste_pct?: number; sort_order?: number }>
  }) {
    let del = supabaseAdmin.from('product_dev_bom').delete().eq('organization_id', orgId).eq('product_dev_id', devId)
    del = body.version_id ? del.eq('version_id', body.version_id) : del.is('version_id', null)
    await del
    const rows = (body.lines ?? []).map((l, idx) => ({
      organization_id: orgId, product_dev_id: devId, version_id: body.version_id ?? null,
      input_id: l.input_id ?? null, kind: l.kind, description: l.description ?? null,
      quantity: Number(l.quantity) || 0, unit: l.unit ?? 'un',
      unit_cost: Number(l.unit_cost) || 0, waste_pct: Number(l.waste_pct) || 0,
      sort_order: l.sort_order ?? idx, created_by: userId,
    }))
    if (rows.length) {
      const { error } = await supabaseAdmin.from('product_dev_bom').insert(rows)
      if (error) throw new BadRequestException(`Erro ao salvar BOM: ${error.message}`)
    }
    return this.getBom(orgId, devId, body.version_id)
  }

  async costFromBom(orgId: string, devId: string, body: { version_id?: string; target_margin_pct?: number } = {}) {
    const lines = await this.getBom(orgId, devId, body.version_id) as Array<{ quantity: number; unit_cost: number; waste_pct: number }>
    if (!lines.length) throw new BadRequestException('Sem BOM cadastrado. Cadastre os insumos ou use o custo estimado.')
    const total = this.round2(lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost) * (1 + Number(l.waste_pct) / 100), 0))
    const targetMargin = Math.min(Math.max(Number(body.target_margin_pct ?? 30), 0), 90)
    const suggested = Object.entries(CHANNEL_ALLIN_FEE_PCT).map(([channel, fee]) => {
      const denom = 1 - fee / 100 - targetMargin / 100
      const price = denom > 0 ? this.round2(total / denom) : 0
      const marginPct = price > 0 ? this.round2(((price - price * fee / 100 - total) / price) * 100) : 0
      return { channel, fee_pct: fee, price, margin_pct: marginPct }
    })
    await supabaseAdmin.from('product_dev').update({ estimated_cost: total }).eq('id', devId).eq('organization_id', orgId)
    return { cost: { total, lines: lines.length }, target_margin_pct: targetMargin, suggested_prices: suggested }
  }

  // ── ordens de produção ────────────────────────────────────────────
  async listOrders(orgId: string, opts: { status?: string } = {}) {
    let q = supabaseAdmin.from('production_order').select('*')
      .eq('organization_id', orgId).order('created_at', { ascending: false })
    if (opts.status) q = q.eq('status', opts.status)
    const { data, error } = await q
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async getOrder(orgId: string, oid: string) {
    const { data, error } = await supabaseAdmin.from('production_order').select('*')
      .eq('id', oid).eq('organization_id', orgId).maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    if (!data) throw new NotFoundException('Ordem não encontrada')
    const { data: jobs } = await supabaseAdmin.from('print_job').select('*')
      .eq('production_order_id', oid).order('job_number', { ascending: true })
    return { ...data, jobs: jobs ?? [] }
  }

  async createOrder(orgId: string, userId: string | null, body: { product_dev_id: string; version_id?: string; quantity: number; machine?: string; printer_id?: string }) {
    const qty = Math.max(1, Math.floor(Number(body.quantity) || 0))
    // pega métricas da versão (explícita > aprovada > última)
    const metrics = await this.resolveVersionMetrics(orgId, body.product_dev_id, body.version_id)
    const estTime = metrics.print_time_minutes != null ? metrics.print_time_minutes * qty : null
    const estFilament = metrics.weight_g != null ? this.round2(metrics.weight_g * qty) : null

    const { data: seq } = await supabaseAdmin.from('production_order').select('order_number')
      .eq('organization_id', orgId).order('order_number', { ascending: false }).limit(1).maybeSingle()
    const nextNumber = seq ? Number((seq as { order_number: number }).order_number) + 1 : 1

    const { data, error } = await supabaseAdmin.from('production_order').insert({
      organization_id: orgId, product_dev_id: body.product_dev_id, version_id: body.version_id ?? null,
      order_number: nextNumber, quantity: qty, machine: body.machine ?? null, printer_id: body.printer_id ?? null,
      estimated_time_minutes: estTime, estimated_filament_g: estFilament, created_by: userId,
    }).select('*').maybeSingle()
    if (error || !data) throw new BadRequestException(`Erro ao criar ordem: ${error?.message ?? 'sem dados'}`)
    const order = data as { id: string }

    // reserva filamento (best-effort)
    if (estFilament && estFilament > 0) {
      const r = await this.inputs.reserveByMaterial(orgId, metrics.material, estFilament, 'production_order', order.id)
      if (r) await supabaseAdmin.from('production_order').update({ reservation_id: r.inputId }).eq('id', order.id)
    }
    await this.emit(orgId, body.product_dev_id, 'production_order_created', { production_order_id: order.id, qty }, userId)
    return this.getOrder(orgId, order.id)
  }

  async transitionOrder(orgId: string, oid: string, to: string, userId: string | null) {
    const order = await this.getOrder(orgId, oid)
    const from = (order as { status: string }).status
    if (from === to) return order
    const allowed = ORDER_TRANSITIONS[from] ?? []
    if (!allowed.includes(to)) throw new BadRequestException(`Transição inválida: '${from}' → '${to}'`)

    const patch: Record<string, unknown> = { status: to }
    if (to === 'imprimindo' && !(order as { started_at: string | null }).started_at) patch.started_at = new Date().toISOString()
    if (to === 'disponivel') patch.completed_at = new Date().toISOString()

    await supabaseAdmin.from('production_order').update(patch).eq('id', oid).eq('organization_id', orgId)

    const devId = (order as { product_dev_id: string }).product_dev_id
    if (to === 'cancelado') {
      await this.inputs.release(orgId, 'production_order', oid)
    }
    if (to === 'disponivel') {
      // baixa insumos + alimenta estoque de produto acabado
      const actual = (order as { actual_filament_g: number | null }).actual_filament_g ?? (order as { estimated_filament_g: number | null }).estimated_filament_g ?? undefined
      await this.inputs.consume(orgId, 'production_order', oid, actual ?? undefined)
      await this.snapshotContribution(orgId, devId, oid, Number((order as { quantity: number }).quantity) || 0)
      await this.feedFinishedGoods(orgId, order as Record<string, unknown>)
      await this.emit(orgId, devId, 'production_completed', { production_order_id: oid }, userId)
    }
    return this.getOrder(orgId, oid)
  }

  /** Alimenta o estoque de produto acabado (Icarus) quando o produto já virou
   *  SKU (product_dev.product_id setado). Idempotente via stock_movement_done. */
  private async feedFinishedGoods(orgId: string, order: Record<string, unknown>) {
    if (order.stock_movement_done === true) return
    const devId = order.product_dev_id as string
    const { data: dev } = await supabaseAdmin.from('product_dev').select('product_id')
      .eq('id', devId).eq('organization_id', orgId).maybeSingle()
    const productId = (dev as { product_id: string | null } | null)?.product_id
    if (!productId) {
      this.logger.log(`[producao] ordem ${(order.id as string).slice(0, 8)} concluída sem SKU vinculado — unidades só no Product OS`)
      return
    }
    try {
      await this.stock.applyProductionRestock({
        productId, quantity: Number(order.quantity) || 0, refId: order.id as string,
        note: `Produção concluída — Product OS`,
      })
      await supabaseAdmin.from('production_order').update({ stock_movement_done: true }).eq('id', order.id as string)
    } catch (e) {
      this.logger.warn(`[producao] feedFinishedGoods falhou: ${(e as Error).message}`)
    }
  }

  /** Carimba custo/preço/contribuição na ordem concluída → alimenta o payback
   *  da impressora. Preço = target_price do produto (ou preço do SKU vinculado). */
  private async snapshotContribution(orgId: string, devId: string, oid: string, quantity: number) {
    const { data: dev } = await supabaseAdmin.from('product_dev').select('estimated_cost, target_price, product_id').eq('id', devId).maybeSingle()
    const d = dev as { estimated_cost: number | null; target_price: number | null; product_id: string | null } | null
    let priceUnit = Number(d?.target_price) || 0
    if (!priceUnit && d?.product_id) {
      const { data: prod } = await supabaseAdmin.from('products').select('price').eq('id', d.product_id).maybeSingle()
      priceUnit = Number((prod as { price: number | null } | null)?.price) || 0
    }
    const costUnit = Number(d?.estimated_cost) || 0
    const contribution = this.round2(Math.max(0, priceUnit - costUnit) * quantity)
    await supabaseAdmin.from('production_order').update({
      unit_cost_snapshot: costUnit, unit_price_snapshot: priceUnit, contribution_total: contribution,
    }).eq('id', oid).eq('organization_id', orgId)
  }

  // ── inteligência de rentabilidade (lucro por hora de impressora) ──
  async profitability(orgId: string) {
    const { data: devs } = await supabaseAdmin.from('product_dev')
      .select('id, name, category, estimated_cost, target_price, product_id, production_profile, status')
      .eq('organization_id', orgId).neq('status', 'arquivado')
    const devRows = (devs ?? []) as Array<{ id: string; name: string; category: string | null; estimated_cost: number | null; target_price: number | null; product_id: string | null; production_profile: string; status: string }>
    if (!devRows.length) return []

    const { data: versions } = await supabaseAdmin.from('product_dev_version')
      .select('product_dev_id, version_number, approved, print_time_minutes').eq('organization_id', orgId)
    const { data: orders } = await supabaseAdmin.from('production_order')
      .select('product_dev_id, quantity, status').eq('organization_id', orgId).eq('status', 'disponivel')

    const linkedIds = devRows.map(d => d.product_id).filter(Boolean) as string[]
    const prods = linkedIds.length ? (await supabaseAdmin.from('products').select('id, price').in('id', linkedIds)).data ?? [] : []
    const priceByProduct = new Map(prods.map(p => [(p as { id: string }).id, Number((p as { price: number | null }).price) || 0]))

    const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const sales = linkedIds.length ? (await supabaseAdmin.from('product_sales_snapshots').select('product_id, units_sold, gross_profit, snapshot_date').eq('organization_id', orgId).gte('snapshot_date', since).in('product_id', linkedIds)).data ?? [] : []
    const salesByProduct = new Map<string, { units: number; profit: number }>()
    for (const s of sales) {
      const row = s as { product_id: string; units_sold: number | null; gross_profit: number | null }
      const cur = salesByProduct.get(row.product_id) ?? { units: 0, profit: 0 }
      cur.units += Number(row.units_sold) || 0; cur.profit += Number(row.gross_profit) || 0
      salesByProduct.set(row.product_id, cur)
    }

    const out = devRows.map(d => {
      const vs = (versions ?? []).filter(v => (v as { product_dev_id: string }).product_dev_id === d.id)
        .sort((a, b) => (b as { version_number: number }).version_number - (a as { version_number: number }).version_number)
      const ref = vs.find(v => (v as { approved: boolean }).approved) ?? vs[0]
      const printMin = ref ? Number((ref as { print_time_minutes: number | null }).print_time_minutes) || 0 : 0
      const costUnit = Number(d.estimated_cost) || 0
      const priceUnit = Number(d.target_price) || (d.product_id ? (priceByProduct.get(d.product_id) ?? 0) : 0)
      const contribution = this.round2(priceUnit - costUnit)
      const profitPerHour = printMin > 0 ? this.round2(contribution / (printMin / 60)) : null
      const sale = d.product_id ? salesByProduct.get(d.product_id) : undefined
      const unitsSold30d = sale?.units ?? 0
      const unitsProduced = (orders ?? []).filter(o => (o as { product_dev_id: string }).product_dev_id === d.id).reduce((s, o) => s + (Number((o as { quantity: number }).quantity) || 0), 0)

      let recommendation: string
      if (profitPerHour == null) recommendation = 'faltam_dados'
      else if (profitPerHour <= 0) recommendation = 'reavaliar'
      else if (unitsSold30d > 0) recommendation = 'priorizar'
      else recommendation = 'validar_demanda'

      return {
        product_dev_id: d.id, name: d.name, category: d.category,
        print_minutes_unit: printMin, cost_unit: costUnit, price_unit: priceUnit,
        contribution_unit: contribution, profit_per_hour: profitPerHour,
        units_sold_30d: unitsSold30d, units_produced: unitsProduced, recommendation,
      }
    })

    return out.sort((a, b) => (b.profit_per_hour ?? -1) - (a.profit_per_hour ?? -1))
  }

  // ── painel da fábrica (visão executiva consolidada) ───────────────
  async factoryOverview(orgId: string) {
    const since30 = new Date(Date.now() - 30 * 86400_000).toISOString()
    const [printersR, ordersR, inputsR, jobsR, prof] = await Promise.all([
      supabaseAdmin.from('production_printer').select('id, name, acquisition_cost, status').eq('organization_id', orgId),
      supabaseAdmin.from('production_order').select('printer_id, status, quantity, contribution_total, completed_at').eq('organization_id', orgId),
      supabaseAdmin.from('production_input').select('id, name, quantity, reserved_quantity, reorder_threshold, unit').eq('organization_id', orgId).eq('is_active', true),
      supabaseAdmin.from('print_job').select('print_time_minutes').eq('organization_id', orgId).eq('status', 'concluido'),
      this.profitability(orgId),
    ])
    const printers = (printersR.data ?? []) as Array<{ id: string; acquisition_cost: number | null; status: string }>
    const orders = (ordersR.data ?? []) as Array<{ printer_id: string | null; status: string; quantity: number; contribution_total: number | null; completed_at: string | null }>
    const inputs = (inputsR.data ?? []) as Array<{ name: string; quantity: number; reserved_quantity: number; reorder_threshold: number; unit: string }>
    const jobs = (jobsR.data ?? []) as Array<{ print_time_minutes: number | null }>

    const done = orders.filter(o => o.status === 'disponivel')
    const totalInvestment = this.round2(printers.reduce((s, p) => s + (Number(p.acquisition_cost) || 0), 0))
    const contribByPrinter = new Map<string, number>()
    let totalContribution = 0
    for (const o of done) {
      const c = Number(o.contribution_total) || 0; totalContribution += c
      if (o.printer_id) contribByPrinter.set(o.printer_id, (contribByPrinter.get(o.printer_id) ?? 0) + c)
    }
    let totalPaidBack = 0, paidOff = 0
    for (const p of printers) {
      const cost = Number(p.acquisition_cost) || 0
      const c = contribByPrinter.get(p.id) ?? 0
      if (cost > 0) { totalPaidBack += Math.min(c, cost); if (c >= cost) paidOff++ }
    }
    totalContribution = this.round2(totalContribution); totalPaidBack = this.round2(totalPaidBack)

    const lowStock = inputs.filter(i => i.reorder_threshold > 0 && (Number(i.quantity) - Number(i.reserved_quantity)) <= i.reorder_threshold)
      .map(i => ({ name: i.name, available: this.round2(Number(i.quantity) - Number(i.reserved_quantity)), unit: i.unit }))

    return {
      printers: {
        count: printers.length,
        active: printers.filter(p => p.status === 'ativa').length,
        total_investment: totalInvestment,
        total_paid_back: totalPaidBack,
        payback_pct: totalInvestment > 0 ? this.round2((totalPaidBack / totalInvestment) * 100) : null,
        paid_off: paidOff,
        total_print_hours: this.round2(jobs.reduce((s, j) => s + (Number(j.print_time_minutes) || 0), 0) / 60),
      },
      production: {
        orders_done: done.length,
        orders_active: orders.filter(o => !['disponivel', 'cancelado'].includes(o.status)).length,
        units_produced: done.reduce((s, o) => s + (Number(o.quantity) || 0), 0),
        units_30d: done.filter(o => o.completed_at && o.completed_at >= since30).reduce((s, o) => s + (Number(o.quantity) || 0), 0),
        total_contribution: totalContribution,
        free_profit: this.round2(Math.max(0, totalContribution - totalPaidBack)),
      },
      inputs: { low_stock: lowStock },
      top_products: prof.slice(0, 5),
    }
  }

  // ── fila de impressão (print jobs) ────────────────────────────────
  async listJobs(orgId: string, oid: string) {
    const { data, error } = await supabaseAdmin.from('print_job').select('*')
      .eq('organization_id', orgId).eq('production_order_id', oid).order('job_number', { ascending: true })
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    return data ?? []
  }

  async createJobs(orgId: string, userId: string | null, oid: string, body: { machine?: string; count?: number }) {
    const order = await this.getOrder(orgId, oid)
    const existing = (order as { jobs: unknown[] }).jobs.length
    const count = Math.min(Math.max(1, Math.floor(Number(body.count) || 1)), 50)
    const rows = Array.from({ length: count }, (_, i) => ({
      organization_id: orgId, production_order_id: oid,
      version_id: (order as { version_id: string | null }).version_id,
      printer_id: (order as { printer_id: string | null }).printer_id,
      job_number: existing + i + 1, machine: body.machine ?? (order as { machine: string | null }).machine, created_by: userId,
    }))
    const { error } = await supabaseAdmin.from('print_job').insert(rows)
    if (error) throw new BadRequestException(`Erro ao criar jobs: ${error.message}`)
    return this.listJobs(orgId, oid)
  }

  async transitionJob(orgId: string, jid: string, body: { status: string; filament_used_g?: number; print_time_minutes?: number; failure_reason?: string }) {
    const { data: job } = await supabaseAdmin.from('print_job').select('*').eq('id', jid).eq('organization_id', orgId).maybeSingle()
    if (!job) throw new NotFoundException('Job não encontrado')
    const patch: Record<string, unknown> = { status: body.status }
    if (body.status === 'imprimindo') patch.started_at = new Date().toISOString()
    if (body.status === 'concluido' || body.status === 'falhou') patch.finished_at = new Date().toISOString()
    if (body.filament_used_g != null) patch.filament_used_g = body.filament_used_g
    if (body.print_time_minutes != null) patch.print_time_minutes = body.print_time_minutes
    if (body.failure_reason != null) patch.failure_reason = body.failure_reason
    await supabaseAdmin.from('print_job').update(patch).eq('id', jid).eq('organization_id', orgId)

    const oid = (job as { production_order_id: string }).production_order_id
    await this.autoAdvanceOrder(orgId, oid, body.status, body.failure_reason)
    return this.getOrder(orgId, oid)
  }

  /** Auto-avança a ordem conforme os jobs: 1º imprimindo→ordem imprimindo;
   *  todos concluídos→acabamento; qualquer falha→falhou. */
  private async autoAdvanceOrder(orgId: string, oid: string, jobStatus: string, failure?: string) {
    const { data: order } = await supabaseAdmin.from('production_order').select('status').eq('id', oid).maybeSingle()
    const cur = (order as { status: string } | null)?.status
    if (!cur || ['disponivel', 'cancelado', 'embalado'].includes(cur)) return

    if (jobStatus === 'imprimindo' && cur === 'fila') {
      await supabaseAdmin.from('production_order').update({ status: 'imprimindo', started_at: new Date().toISOString() }).eq('id', oid)
      return
    }
    if (jobStatus === 'falhou') {
      await supabaseAdmin.from('production_order').update({ status: 'falhou', notes: failure ?? 'Falha em job de impressão' }).eq('id', oid)
      return
    }
    if (jobStatus === 'concluido') {
      const { data: jobs } = await supabaseAdmin.from('print_job').select('status, filament_used_g, print_time_minutes').eq('production_order_id', oid)
      const all = jobs ?? []
      if (all.length && all.every(j => (j as { status: string }).status === 'concluido')) {
        const actualFil = all.reduce((s, j) => s + (Number((j as { filament_used_g: number | null }).filament_used_g) || 0), 0)
        const actualTime = all.reduce((s, j) => s + (Number((j as { print_time_minutes: number | null }).print_time_minutes) || 0), 0)
        await supabaseAdmin.from('production_order').update({
          status: 'acabamento',
          actual_filament_g: actualFil > 0 ? this.round2(actualFil) : null,
          actual_time_minutes: actualTime > 0 ? actualTime : null,
        }).eq('id', oid)
      }
    }
  }

  // ── qualidade ─────────────────────────────────────────────────────
  async getQuality(orgId: string, devId: string, versionId?: string) {
    let q = supabaseAdmin.from('product_dev_quality').select('*')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('created_at', { ascending: false }).limit(1)
    if (versionId) q = q.eq('version_id', versionId)
    const { data } = await q
    return (data ?? [])[0] ?? null
  }

  async upsertQuality(orgId: string, devId: string, userId: string | null, body: {
    version_id?: string; production_order_id?: string; checklist: Array<{ key: string; label: string; ok: boolean }>; approved: boolean; notes?: string
  }) {
    const existing = await this.getQuality(orgId, devId, body.version_id) as { id: string } | null
    const payload = {
      organization_id: orgId, product_dev_id: devId, version_id: body.version_id ?? null,
      production_order_id: body.production_order_id ?? null, checklist: body.checklist ?? [],
      approved: body.approved === true, notes: body.notes ?? null, checked_by: userId,
    }
    if (existing) {
      const { data, error } = await supabaseAdmin.from('product_dev_quality').update(payload).eq('id', existing.id).select('*').maybeSingle()
      if (error) throw new BadRequestException(`Erro: ${error.message}`)
      await this.emit(orgId, devId, 'quality_checked', { approved: payload.approved }, userId)
      return data
    }
    const { data, error } = await supabaseAdmin.from('product_dev_quality').insert(payload).select('*').maybeSingle()
    if (error) throw new BadRequestException(`Erro: ${error.message}`)
    await this.emit(orgId, devId, 'quality_checked', { approved: payload.approved }, userId)
    return data
  }

  /** Gate de publicação: qualidade aprovada? (bypass p/ perfil genérico sem QC). */
  async isQualityPassed(orgId: string, devId: string, profile: string): Promise<boolean> {
    const q = await this.getQuality(orgId, devId) as { approved: boolean } | null
    if (q) return q.approved === true
    return profile === 'generico'   // genérico/marca própria sem QC não trava
  }

  // ── helpers ───────────────────────────────────────────────────────
  private async resolveVersionMetrics(orgId: string, devId: string, versionId?: string): Promise<VersionMetrics> {
    const { data } = await supabaseAdmin.from('product_dev_version')
      .select('id, weight_g, print_time_minutes, material, approved, version_number')
      .eq('organization_id', orgId).eq('product_dev_id', devId).order('version_number', { ascending: false })
    const versions = (data ?? []) as Array<VersionMetrics & { id: string; approved: boolean }>
    const ref = versionId ? versions.find(v => v.id === versionId) : (versions.find(v => v.approved) ?? versions[0])
    return { weight_g: ref?.weight_g ?? null, print_time_minutes: ref?.print_time_minutes ?? null, material: ref?.material ?? null }
  }
}
